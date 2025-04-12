import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { WebSocketClient } from '../websocket/client'; // The original client
import { WebSocketConfig, WebSocketMessage, WebSocketMessageType } from '../websocket/types';
import { IE2EEKeyStorage, E2EEKeyPair, ExtensionKeyStorage } from './keyStorage';
import {
    initializeSodium,
    computeSharedSecret,
    deriveKeys,
    generateNonce,
    encryptMessage,
    decryptMessage,
    hashData,
    bytesToHex,
    hexToBytes
} from './crypto';
import sodium from 'libsodium-wrappers'; // Import sodium type for constants

// Define E2EE-specific message types/actions
const E2EE_REQUEST_PAIRING = 'e2ee-request-pairing';
const E2EE_PUBKEY_EXCHANGE = 'e2ee-pubkey-exchange';
const E2EE_VERIFY = 'e2ee-verify';
const E2EE_PAIRING_CODE = 'e2ee-pairing-code'; // For extension to send code *display* info

type E2EEState =
    | 'uninitialized' // Sodium not ready
    | 'disconnected' // WS disconnected, E2EE inactive
    | 'connecting'   // WS connecting
    | 'checking_pairing' // WS connected, checking stored peer key
    | 'requesting_pairing' // Sent pairing request to peer
    | 'awaiting_peer_pubkey' // Received pairing request, awaiting peer pubkey
    | 'awaiting_pairing_code_entry' // Peer pubkey received, generated code, awaiting user entry confirmation via verify message
    | 'awaiting_verification' // Sent own verification hash, awaiting peer's verification
    | 'paired' // E2EE channel established
    | 'pairing_failed'; // Pairing process failed

// Interface for the payload of E2EE messages
interface E2EEPayloadPubKey {
    publicKey: string; // hex encoded
    deviceId: string; // Sender's device ID
}

interface E2EEPayloadVerify {
    hash: string; // hex encoded verification hash
}

interface E2EEPayloadPairingCode {
    code: string; // The pairing code to display
}


export class EncryptedWebSocketClient extends EventEmitter {
    private underlyingClient: WebSocketClient;
    private keyStorage: ExtensionKeyStorage;
    private state: E2EEState = 'uninitialized';
    private ownKeyPair: E2EEKeyPair | null = null;
    private peerPublicKey: Uint8Array | null = null;
    private peerDeviceId: string | null = null; // ID of the connected Web UI
    private txKey: Uint8Array | null = null; // Key for encrypting outgoing messages
    private rxKey: Uint8Array | null = null; // Key for decrypting incoming messages
    private pairingCode: string | null = null; // The current pairing code (if generated)
    private pairingResolve: (() => void) | null = null;
    private pairingReject: ((reason?: any) => void) | null = null;
    private sodiumInstance: typeof sodium | null = null;

    // Re-emit events from underlying client, plus E2EE state changes
    public static readonly Events = {
        Connecting: 'connecting',
        Connected: 'connected', // Underlying WS connected, E2EE *may* not be paired yet
        Disconnected: 'disconnected',
        Error: 'error',
        Message: 'message', // Decrypted message
        E2EEStateChange: 'e2ee_state_change', // Emits the new E2EEState
        PairingCodeGenerated: 'pairing_code_generated', // Emits the code for UI display
    };

    constructor(config: WebSocketConfig, context: vscode.ExtensionContext) {
        super();
        this.underlyingClient = new WebSocketClient(config);
        this.keyStorage = new ExtensionKeyStorage(context);
        this.setupEventForwarding();
        this.initialize();
    }

    private async initialize() {
        try {
            this.sodiumInstance = await initializeSodium();
            this.ownKeyPair = await this.keyStorage.getOwnKeyPair();
            this.setState('disconnected'); // Ready, but not connected yet
        } catch (error) {
			vscode.window.showErrorMessage("E2EE Crypto Initialization Failed");
            console.error("E2EE Initialization failed:", error);
            this.setState('pairing_failed'); // Treat as failed if crypto fails
            this.emit(EncryptedWebSocketClient.Events.Error, new Error("E2EE Crypto Initialization Failed"));
        }
    }

    private setState(newState: E2EEState) {
        if (this.state !== newState) {
            console.log(`E2EE State Transition: ${this.state} -> ${newState}`);
            this.state = newState;
            this.emit(EncryptedWebSocketClient.Events.E2EEStateChange, newState);
        }
    }

    private setupEventForwarding() {
        this.underlyingClient.on('connecting', () => {
            this.setState('connecting');
            this.emit(EncryptedWebSocketClient.Events.Connecting);
        });

        this.underlyingClient.on('connected', () => {
            this.emit(EncryptedWebSocketClient.Events.Connected);
            // Don't set state to 'paired' yet, start pairing check
            this.startPairingProcess();
        });

        this.underlyingClient.on('disconnected', () => {
            this.resetE2EEState(); // Reset keys and state on disconnect
            this.emit(EncryptedWebSocketClient.Events.Disconnected);
        });

        this.underlyingClient.on('error', (err) => {
            // If it's a connection error before pairing, reset state
            if (this.state !== 'paired') {
                this.resetE2EEState();
            }
            this.emit(EncryptedWebSocketClient.Events.Error, err);
        });

        this.underlyingClient.on('message', (message: WebSocketMessage) => {
            this.handleIncomingMessage(message);
        });
    }

    private resetE2EEState() {
        this.peerPublicKey = null;
        this.peerDeviceId = null;
        this.txKey = null;
        this.rxKey = null;
        this.pairingCode = null;
        if (this.pairingReject) {
            this.pairingReject(new Error("Disconnected during pairing"));
            this.pairingReject = null;
            this.pairingResolve = null;
        }
        // Only reset state if it wasn't already failed/uninitialized
        if (this.state !== 'pairing_failed' && this.state !== 'uninitialized') {
             this.setState('disconnected');
        }
    }

    // --- Public API ---

    public connect(): Promise<void> {
        if (this.state === 'uninitialized') {
            return Promise.reject(new Error("E2EE not initialized yet."));
        }
        // The promise resolves when the *underlying* connection is up.
        // Pairing happens afterwards.
        return this.underlyingClient.connect();
    }

    public disconnect() {
        this.underlyingClient.disconnect();
        // State will be updated via 'disconnected' event handler
    }

    public send(message: Omit<WebSocketMessage, 'id' | 'clientType'>): Promise<void> {
        if (this.state !== 'paired') {
            // Maybe queue messages sent before pairing is complete? Or reject?
            // For now, reject if not paired.
            console.warn("Attempted to send message before E2EE pairing complete. State:", this.state);
            return Promise.reject(new Error("E2EE channel not established."));
        }
        if (!this.txKey || !message.payload) {
             // Should not happen if state is 'paired', but check anyway
             console.error("Cannot send message: Missing txKey or payload in 'paired' state.");
             return Promise.reject(new Error("Internal E2EE error: Cannot encrypt message."));
        }

        try {
            const nonce = generateNonce();
            const payloadBytes = new TextEncoder().encode(JSON.stringify(message.payload));
            const ciphertext = encryptMessage(payloadBytes, this.txKey, nonce);

            const encryptedPayload = {
                nonce: bytesToHex(nonce),
                ciphertext: bytesToHex(ciphertext),
            };

            const messageToSend: WebSocketMessage = {
                ...message,
                payload: encryptedPayload, // Replace payload with encrypted version
                type: message.type, // Ensure type is preserved
                 // Add flag? Or rely on payload structure? Let's rely on structure for now.
                 // isEncrypted: true
            };
            return this.underlyingClient.send(messageToSend); // Send via original client
        } catch (error) {
            console.error("E2EE Encryption failed:", error);
            return Promise.reject(new Error("E2EE Encryption failed."));
        }
    }

    public getE2EEState(): E2EEState {
        return this.state;
    }

    // --- Pairing Logic ---

    private async startPairingProcess() {
        if (this.state === 'uninitialized' || !this.ownKeyPair) {
             console.error("Cannot start pairing: E2EE not initialized.");
             this.setState('pairing_failed');
             return;
        }
        this.setState('checking_pairing');

        // In the extension, we wait for the Web UI to initiate pairing
        console.log("E2EE: Waiting for Web UI to initiate pairing...");
        // Timeout?
    }

    private handleIncomingMessage(message: WebSocketMessage) {
        // Handle E2EE control messages
        if (message.type === 'e2ee') {
            this.handleE2EEMessage(message);
            return;
        }

        // Handle regular messages (decrypt if needed)
        if (this.state === 'paired' && this.rxKey && message.payload && message.payload.nonce && message.payload.ciphertext) {
            try {
                const nonce = hexToBytes(message.payload.nonce);
                const ciphertext = hexToBytes(message.payload.ciphertext);
                const decryptedBytes = decryptMessage(ciphertext, this.rxKey, nonce);

                if (decryptedBytes) {
                    const decryptedPayload = JSON.parse(new TextDecoder().decode(decryptedBytes));
                    const decryptedMessage: WebSocketMessage = {
                        ...message,
                        payload: decryptedPayload,
                    };
                    this.emit(EncryptedWebSocketClient.Events.Message, decryptedMessage);
                } else {
                    console.error("E2EE Decryption failed for message:", message.id);
                    // Handle decryption failure - maybe disconnect? Or notify user?
                    this.emit(EncryptedWebSocketClient.Events.Error, new Error(`Decryption failed for message ${message.id}`));
                    // Consider resetting pairing state or disconnecting if decryption fails repeatedly
                     this.setState('pairing_failed');
                     this.disconnect();
                }
            } catch (error) {
                console.error("Error during E2EE decryption or parsing:", error);
                this.emit(EncryptedWebSocketClient.Events.Error, new Error(`Decryption processing error for message ${message.id}`));
                 this.setState('pairing_failed');
                 this.disconnect();
            }
        } else if (this.state !== 'paired' && message.payload && message.payload.nonce && message.payload.ciphertext) {
             console.warn("Received encrypted message but E2EE state is not 'paired'. State:", this.state, "Msg ID:", message.id);
             // Ignore or error? Ignoring for now.
        }
        else {
            // Message is not E2EE-related or not encrypted, pass through
             // Although, in theory, *all* payload messages should be encrypted once paired.
             if (this.state === 'paired') {
                 console.warn("Received unencrypted message while in 'paired' state:", message);
             }
            this.emit(EncryptedWebSocketClient.Events.Message, message);
        }
    }

    private async handleE2EEMessage(message: WebSocketMessage) {
        if (!message.action || !message.payload) {
            console.warn("Received invalid E2EE message:", message);
            return;
        }

        console.log(`Received E2EE message: Action=${message.action}, State=${this.state}`);

        switch (message.action) {
            case E2EE_REQUEST_PAIRING:
                // Web UI wants to pair
                if (this.state === 'checking_pairing' || this.state === 'disconnected' || this.state === 'connecting') { // Allow pairing request in these states
                    const { deviceId: webUiDeviceId } = message.payload;
                    if (!webUiDeviceId || typeof webUiDeviceId !== 'string') {
                         console.error("Invalid pairing request: Missing or invalid deviceId");
                         return;
                    }
                    this.peerDeviceId = webUiDeviceId;
                    console.log(`Pairing requested by Web UI device: ${this.peerDeviceId}`);
                    await this.initiatePairingResponse();
                } else {
                     console.warn(`Ignoring ${E2EE_REQUEST_PAIRING} in state ${this.state}`);
                }
                break;

            case E2EE_PUBKEY_EXCHANGE:
                 // Received Web UI's public key
                 if (this.state === 'awaiting_peer_pubkey') {
                     const { publicKey: peerKeyHex, deviceId: peerDeviceId } = message.payload as E2EEPayloadPubKey;
                     if (!peerKeyHex || typeof peerKeyHex !== 'string' || peerDeviceId !== this.peerDeviceId) {
                         console.error("Invalid pubkey exchange payload or mismatched device ID.");
                          this.setState('pairing_failed');
                          this.pairingReject?.(new Error("Invalid public key exchange message"));
                         return;
                     }
                     try {
                         this.peerPublicKey = hexToBytes(peerKeyHex);
                         console.log("Received peer public key.");
                         await this.generateAndSendPairingCode();
                     } catch (e) {
                         console.error("Failed to parse peer public key hex:", e);
                          this.setState('pairing_failed');
                          this.pairingReject?.(new Error("Invalid peer public key format"));
                     }
                 } else {
                      console.warn(`Ignoring ${E2EE_PUBKEY_EXCHANGE} in state ${this.state}`);
                 }
                break;

            case E2EE_VERIFY:
                // Received Web UI's verification hash
                 if (this.state === 'awaiting_verification') {
                     const { hash: peerHashHex } = message.payload as E2EEPayloadVerify;
                      if (!peerHashHex || typeof peerHashHex !== 'string') {
                         console.error("Invalid verify payload.");
                          this.setState('pairing_failed');
                          this.pairingReject?.(new Error("Invalid verification message"));
                         return;
                     }
                     try {
                         const peerHash = hexToBytes(peerHashHex);
                         await this.verifyPeer(peerHash);
                     } catch (e) {
                         console.error("Failed to parse peer verification hex:", e);
                          this.setState('pairing_failed');
                          this.pairingReject?.(new Error("Invalid peer verification format"));
                     }
                 } else {
                      console.warn(`Ignoring ${E2EE_VERIFY} in state ${this.state}`);
                 }
                break;

            default:
                console.warn("Received unknown E2EE action:", message.action);
        }
    }

     private async initiatePairingResponse() {
         if (!this.ownKeyPair || !this.peerDeviceId) return; // Should be set by now

         this.setState('awaiting_peer_pubkey');

         // Check if we are already paired with this device ID
         const storedPeerKey = await this.keyStorage.getPeerPublicKey(this.peerDeviceId);
         if (storedPeerKey) {
             console.log(`Already paired with ${this.peerDeviceId}. Re-establishing secure channel.`);
             this.peerPublicKey = storedPeerKey;
             // Send our public key anyway for session key derivation
             const payload: E2EEPayloadPubKey = {
                 publicKey: bytesToHex(this.ownKeyPair.publicKey),
                 deviceId: await this.keyStorage.getDeviceId()
             };
             await this.sendE2EEMessage(E2EE_PUBKEY_EXCHANGE, payload);
             // Directly compute keys and transition to paired
             await this.computeSessionKeysAndFinishPairing();

         } else {
             console.log(`Not paired with ${this.peerDeviceId}. Starting full pairing flow.`);
             // Send our public key to start the exchange
             const payload: E2EEPayloadPubKey = {
                 publicKey: bytesToHex(this.ownKeyPair.publicKey),
                 deviceId: await this.keyStorage.getDeviceId()
             };
             await this.sendE2EEMessage(E2EE_PUBKEY_EXCHANGE, payload);
             // Now wait for the peer's public key in handleE2EEMessage
         }
     }

     private async generateAndSendPairingCode() {
         if (!this.sodiumInstance) return;
         // Generate a 6-digit pairing code
         this.pairingCode = this.sodiumInstance.randombytes_uniform(1000000).toString().padStart(6, '0');
         console.log(`Generated pairing code: ${this.pairingCode}`); // Log for debugging

         // Emit event for VS Code UI to display the code
         this.emit(EncryptedWebSocketClient.Events.PairingCodeGenerated, this.pairingCode);

         // Transition state - we are now waiting for the user to enter the code
         // on the peer and for the peer to send its verification hash.
         this.setState('awaiting_verification');

         // We don't send the code itself over WS. The user transfers it manually.
         // We now wait for the E2EE_VERIFY message from the peer.
     }


     private async verifyPeer(peerHash: Uint8Array) {
      console.log("verifyPeer: Verifying peer hash..."); // Log entry
      if (!this.ownKeyPair || !this.peerPublicKey || !this.pairingCode || !this.sodiumInstance) {
     	 console.error("verifyPeer: Cannot verify peer - Missing keys or pairing code.", { hasOwnKey: !!this.ownKeyPair, hasPeerKey: !!this.peerPublicKey, hasCode: !!this.pairingCode });
     	 this.setState('pairing_failed');
     	 this.pairingReject?.(new Error("Internal error during verification"));
     	 return;
         }

         try {
             const sharedSecret = computeSharedSecret(this.ownKeyPair.privateKey, this.peerPublicKey);
             const codeBytes = this.sodiumInstance.from_string(this.pairingCode);
             const dataToHash = new Uint8Array([...sharedSecret, ...codeBytes]); // Combine secret and code
             const expectedHash = hashData(dataToHash);

             console.log("verifyPeer: Comparing received hash with expected hash."); // Log comparison point
             if (this.sodiumInstance.compare(peerHash, expectedHash) === 0) {
              // Hashes match! Peer is verified.
              console.log("verifyPeer: Peer verification successful!");

                 // Save peer key persistently
                 await this.keyStorage.savePeerPublicKey(this.peerDeviceId!, this.peerPublicKey);

                 // Compute session keys and finish
                 await this.computeSessionKeysAndFinishPairing(sharedSecret);

             } else {
                 // Hash mismatch! Potential MITM or incorrect code entry.
                 console.error("verifyPeer: Peer verification failed! Hash mismatch."); // Log mismatch
                 vscode.window.showErrorMessage("Pairing failed: Verification code mismatch. Please try again.");
                 this.setState('pairing_failed');
                 this.pairingReject?.(new Error("Verification failed"));
                 // Do NOT save the peer key if verification fails
             }
         } catch (error) {
             console.error("verifyPeer: Error during peer verification:", error); // Log error
             this.setState('pairing_failed');
             this.pairingReject?.(new Error("Error during verification process"));
         } finally {
              this.pairingCode = null; // Clear the code after attempt
              this.pairingResolve = null;
              this.pairingReject = null;
         }
     }

     private async computeSessionKeysAndFinishPairing(sharedSecret?: Uint8Array) {
      console.log("computeSessionKeysAndFinishPairing: Attempting to compute session keys..."); // Log entry
      if (!this.ownKeyPair || !this.peerPublicKey) {
     	 console.error("computeSessionKeysAndFinishPairing: Cannot compute session keys - Missing keys.", { hasOwnKey: !!this.ownKeyPair, hasPeerKey: !!this.peerPublicKey });
     	 this.setState('pairing_failed');
     	 this.pairingReject?.(new Error("Internal error: Missing keys for session key derivation"));
     	 return; // Return explicitly after failure
         }

         try {
             const secret = sharedSecret ?? computeSharedSecret(this.ownKeyPair.privateKey, this.peerPublicKey);
             const keyLength = this.sodiumInstance!.crypto_aead_chacha20poly1305_ietf_KEYBYTES;
             const context = "RooE2EE_v1"; // Key derivation context

             // Derive keys - Extension Tx = WebUI Rx, Extension Rx = WebUI Tx
             const { txKey: derivedTxKey, rxKey: derivedRxKey } = await deriveKeys(secret, keyLength, context);

             // Determine which key is for sending (tx) and receiving (rx) based on who initiated?
             // Let's assume Extension always uses ID 1 for Tx, ID 2 for Rx derivation.
             // WebUI should do the opposite (ID 1 for *its* Tx = Ext Rx, ID 2 for *its* Rx = Ext Tx)
             // So, the derived keys are correct as assigned.
             this.txKey = derivedTxKey;
             this.rxKey = derivedRxKey;

             this.setState('paired');
             console.log("computeSessionKeysAndFinishPairing: Session keys derived. Setting state to 'paired'."); // Log success before state change
             this.setState('paired');
             console.log("computeSessionKeysAndFinishPairing: E2EE Pairing Complete. Secure channel established.");
             this.pairingResolve?.(); // Resolve the pairing promise if any

         } catch (error) {
             console.error("computeSessionKeysAndFinishPairing: Failed to derive session keys:", error); // Log error
             this.setState('pairing_failed');
             this.pairingReject?.(new Error("Failed to derive session keys"));
         } finally {
              this.pairingResolve = null;
              this.pairingReject = null;
         }
     }

    // Helper to send E2EE control messages
    private sendE2EEMessage(action: string, payload: any): Promise<void> {
        const message: WebSocketMessage = {
            type: 'e2ee', // Specific type for E2EE signaling
            action: action,
            payload: payload,
        };
        // E2EE control messages are sent unencrypted via the underlying client
        return this.underlyingClient.send(message);
    }
}