import { WsClient } from '../ws-client'; // The original client
// Adjust import paths for shared code copied locally
import { WebUIKeyStorage, IE2EEKeyStorage, E2EEKeyPair } from './keyStorage';
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
import sodium from 'libsodium-wrappers';

// Constants for E2EE message actions
const E2EE_REQUEST_PAIRING = 'e2ee-request-pairing';
const E2EE_PUBKEY_EXCHANGE = 'e2ee-pubkey-exchange';
const E2EE_VERIFY = 'e2ee-verify';

// Define E2EE State type
type E2EEState =
	| 'uninitialized'
	| 'disconnected'
	| 'connecting' // Underlying WS connecting
	| 'checking_pairing' // WS connected, checking stored peer key
	| 'requesting_pairing' // Sent pairing request to peer
	| 'awaiting_peer_pubkey' // Received pairing request OR re-pairing, sent own key, waiting for peer's key
	| 'awaiting_pairing_code' // Peer key received (first time), sent own key, waiting for user code input via submitPairingCode()
	| 'awaiting_verification' // Sent own verification hash, awaiting implicit confirmation from peer
	| 'paired' // E2EE channel established
	| 'pairing_failed'; // Pairing process failed

// Interfaces for E2EE message payloads
interface E2EEPayloadPubKey {
	publicKey: string; // hex encoded
	deviceId: string;
}

interface E2EEPayloadVerify {
	hash: string; // hex encoded verification hash
}

// Define the structure for WebSocket messages (aligns with shared type)
interface WsMessage {
	id?: string;
	type: string; // Includes 'e2ee'
	action?: string;
	payload?: any;
	error?: string;
	clientType?: "webui" | "extension";
}

export class EncryptedWsClient {
	private underlyingClient: WsClient;
	private keyStorage: WebUIKeyStorage;
	private state: E2EEState = 'uninitialized';
	private ownKeyPair: E2EEKeyPair | null = null;
	private peerPublicKey: Uint8Array | null = null;
	private peerDeviceId: string | null = null; // ID of the connected Extension
	private txKey: Uint8Array | null = null;
	private rxKey: Uint8Array | null = null;
	private pairingPromise: Promise<void> | null = null;
	private sodiumInstance: typeof sodium | null = null;

	private eventTarget = new EventTarget();

	public static readonly Events = {
		Connecting: 'connecting', // Note: Not emitted by underlying WsClient currently
		Connected: 'connected', // Underlying WS connected
		Disconnected: 'disconnected',
		Error: 'error',
		Message: 'message', // Decrypted application message
		E2EEStateChange: 'e2ee_state_change', // Emits the new E2EEState
		PairingRequired: 'pairing_required', // Emitted when user input (code) is needed
	};

	constructor() {
		this.underlyingClient = new WsClient();
		this.keyStorage = new WebUIKeyStorage();
		this.setupEventForwarding();
		this.initialize();
	}

	private async initialize() {
		try {
			this.sodiumInstance = await initializeSodium();
			this.ownKeyPair = await this.keyStorage.getOwnKeyPair();
			this.setState('disconnected');
		} catch (error) {
			console.error("E2EE Initialization failed:", error);
			this.setState('pairing_failed');
			this.emit(EncryptedWsClient.Events.Error, new Error("E2EE Crypto Initialization Failed"));
		}
	}

	private setState(newState: E2EEState) {
		if (this.state !== newState) {
			console.log(`E2EE State Transition (WebUI): ${this.state} -> ${newState}`); // Added logging
			this.state = newState;
			this.emit(EncryptedWsClient.Events.E2EEStateChange, newState);
		}
	}

	private setupEventForwarding() {
		// Instruct the underlying client *not* to handle messages itself
		this.underlyingClient.setExternalMessageHandler();

		// Listen for the underlying client's connection events
		this.underlyingClient.on('connected', () => {
			console.log("Underlying WS connected."); // Added logging
			this.emit(EncryptedWsClient.Events.Connected); // Notify wrapper users
			const socket = this.underlyingClient.getRawSocket();
			if (socket) {
				console.log("EncryptedClient: Attaching raw onmessage handler.");
				// Set our handler directly on the raw socket
				socket.onmessage = (event: MessageEvent) => {
					this.handleRawIncomingMessage(event.data);
				};
			} else {
				console.error("EncryptedClient: Failed to get raw socket on connect.");
				this.setState('pairing_failed');
				this.emit(EncryptedWsClient.Events.Error, new Error("Failed to access underlying socket"));
			}
			// Start E2EE handshake *after* WS is connected and handler is attached
			this.startPairingProcess();
		});

		this.underlyingClient.on('disconnected', (event) => {
			console.log("Underlying WS disconnected."); // Added logging
			this.resetE2EEState();
			this.emit(EncryptedWsClient.Events.Disconnected, event?.detail);
		});

		this.underlyingClient.on('error', (event) => {
			console.log("Underlying WS error event."); // Added logging
			const errorDetail = event?.detail instanceof Error ? event.detail : new Error(String(event?.detail ?? 'Unknown WebSocket error'));
			if (this.state !== 'paired') {
				this.resetE2EEState();
			}
			this.emit(EncryptedWsClient.Events.Error, errorDetail);
		});
	}

	// New method to handle raw data and parse before passing to E2EE logic
	private handleRawIncomingMessage(rawData: any) {
		try {
			const message = JSON.parse(rawData.toString()) as WsMessage;
			// console.log("Raw message parsed:", message); // Optional: Verbose logging
			this.handleIncomingMessage(message); // Pass parsed message to existing handler
		} catch (err) {
			console.error("Failed to parse incoming WebSocket message:", err, "Raw data:", rawData);
			this.emit(EncryptedWsClient.Events.Error, new Error("Failed to parse incoming message"));
			this.setState('pairing_failed');
			this.disconnect();
		}
	}

	private resetE2EEState() {
		console.log("Resetting E2EE state."); // Added logging
		this.peerPublicKey = null;
		this.peerDeviceId = null;
		this.txKey = null;
		this.rxKey = null;
		this.pairingPromise = null;
		if (this.state !== 'pairing_failed' && this.state !== 'uninitialized') {
			 this.setState('disconnected');
		}
	}

	// --- Public API ---
	setURL(url: string) { this.underlyingClient.setURL(url); return this; }
	setClientType(type: "webui" | "extension") { this.underlyingClient.setClientType(type); return this; }
	setSessionId(sessionId: string | null) { this.underlyingClient.setSessionId(sessionId); return this; }
	setAuthToken(token: string | null) { this.underlyingClient.setAuthToken(token); return this; }

	connect(): Promise<void> {
		if (this.state === 'uninitialized') {
			console.warn("Connect called before E2EE initialized.");
			return Promise.reject(new Error("E2EE not initialized yet."));
		}
		console.log("EncryptedClient: Initiating connection...");
		return this.underlyingClient.connect();
	}

	disconnect() {
		console.log("EncryptedClient: Disconnecting...");
		this.underlyingClient.disconnect();
	}

	send(message: Omit<WsMessage, 'id' | 'clientType'>): Promise<void> {
		if (this.state !== 'paired') {
			console.warn("Attempted to send message before E2EE pairing complete. State:", this.state);
			return Promise.reject(new Error("E2EE channel not established."));
		}
		 if (!this.txKey || !message.payload) {
			 console.error("Cannot send message: Missing txKey or payload in 'paired' state.");
			 return Promise.reject(new Error("Internal E2EE error: Cannot encrypt message."));
		}

		// console.log("Encrypting and sending message:", message); // Optional: Verbose logging
		try {
			const nonce = generateNonce();
			const payloadString = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload);
			const payloadBytes = new TextEncoder().encode(payloadString);
			const ciphertext = encryptMessage(payloadBytes, this.txKey, nonce);

			const encryptedPayload = {
				nonce: bytesToHex(nonce),
				ciphertext: bytesToHex(ciphertext),
			};

			const messageToSend: WsMessage = {
				...message,
				payload: encryptedPayload,
				type: message.type,
			};
			return this.underlyingClient.send(messageToSend);
		} catch (error) {
			console.error("E2EE Encryption failed:", error);
			return Promise.reject(new Error("E2EE Encryption failed."));
		}
	}

	// --- Event Listener ---
	on(event: string, listener: (event: CustomEvent) => void) {
		this.eventTarget.addEventListener(event, listener as EventListener);
	}

	off(event: string, listener: (event: CustomEvent) => void) {
		this.eventTarget.removeEventListener(event, listener as EventListener);
	}

	private emit(event: string, detail?: unknown) {
		this.eventTarget.dispatchEvent(new CustomEvent(event, { detail }));
	}

	getE2EEState(): E2EEState {
		return this.state;
	}

	getStatus(): "disconnected" | "connecting" | "connected" {
		return this.underlyingClient.getStatus();
	}

	// --- Pairing Logic ---
	private async startPairingProcess() {
		console.log("Starting E2EE pairing process..."); // Added logging
		if (this.state === 'uninitialized' || !this.ownKeyPair) {
			 console.error("Cannot start pairing: E2EE not initialized.");
			 this.setState('pairing_failed');
			 return;
		}
		this.setState('checking_pairing');

		// Placeholder for getting the actual Extension ID
		const extensionInstanceId = "extension_instance_1"; // TODO: Replace with actual ID mechanism
		this.peerDeviceId = extensionInstanceId;
		console.log(`Attempting to pair with Extension ID: ${this.peerDeviceId}`);

		const storedPeerKey = await this.keyStorage.getPeerPublicKey(this.peerDeviceId);

		if (storedPeerKey) {
			console.log(`Already paired with ${this.peerDeviceId}. Re-establishing secure channel.`);
			this.peerPublicKey = storedPeerKey;
			await this.sendPublicKey();
			this.setState('awaiting_peer_pubkey'); // Wait for extension's key for session derivation
		} else {
			console.log(`Not paired with ${this.peerDeviceId}. Requesting pairing.`);
			this.setState('requesting_pairing');
			const deviceId = await this.keyStorage.getDeviceId();
			await this.sendE2EEMessage(E2EE_REQUEST_PAIRING, { deviceId });
			// Wait for E2EE_PUBKEY_EXCHANGE message from extension
		}
	}

	public async submitPairingCode(code: string): Promise<void> {
		console.log(`submitPairingCode: Called with code ${code} (State: ${this.state})`); // Log entry
		// Should be called when state is 'awaiting_pairing_code'
		if (this.state !== 'awaiting_pairing_code') {
			 console.warn("submitPairingCode: Called in incorrect state:", this.state);
			 throw new Error(`Not awaiting pairing code (state is ${this.state}).`);
		}
		if (!this.ownKeyPair || !this.peerPublicKey || !this.sodiumInstance) {
			console.error("submitPairingCode: Cannot submit pairing code - Missing keys.", { hasOwnKey: !!this.ownKeyPair, hasPeerKey: !!this.peerPublicKey });
			this.setState('pairing_failed');
			throw new Error("Internal error during pairing code submission.");
		}

		try {
			const sharedSecret = computeSharedSecret(this.ownKeyPair.privateKey, this.peerPublicKey);
			const codeBytes = this.sodiumInstance.from_string(code);
			const dataToHash = new Uint8Array(sharedSecret.length + codeBytes.length);
			dataToHash.set(sharedSecret, 0);
			dataToHash.set(codeBytes, sharedSecret.length);
			const verificationHash = hashData(dataToHash);

			console.log("submitPairingCode: Sending verification hash to extension."); // Log sending hash
			const payload: E2EEPayloadVerify = { hash: bytesToHex(verificationHash) };
			await this.sendE2EEMessage(E2EE_VERIFY, payload);

			this.setState('awaiting_verification'); // Now wait for implicit confirmation

			console.log("Computing session keys optimistically."); // Added logging
			await this.computeSessionKeys(sharedSecret);
			// Note: State transition to 'paired' happens in computeSessionKeys if successful

		} catch (error) {
			console.error("submitPairingCode: Error processing pairing code:", error); // Log error
			this.setState('pairing_failed');
			throw new Error("Failed to process pairing code.");
		}
	}

	private handleIncomingMessage(message: WsMessage) {
		// console.log("Handling incoming message:", message); // Optional: Verbose logging
		// Handle E2EE control messages
		if (message.type === 'e2ee') {
			this.handleE2EEMessage(message);
			return;
		}

		// Handle regular messages (decrypt if needed)
		if (this.state === 'paired' && this.rxKey && message.payload?.nonce && message.payload?.ciphertext) {
			// console.log("Attempting decryption for message:", message.id); // Optional: Verbose logging
			try {
				const nonce = hexToBytes(message.payload.nonce);
				const ciphertext = hexToBytes(message.payload.ciphertext);
				const decryptedBytes = decryptMessage(ciphertext, this.rxKey, nonce);

				if (decryptedBytes) {
					let decryptedPayload;
					try {
						decryptedPayload = JSON.parse(new TextDecoder().decode(decryptedBytes));
					} catch {
						decryptedPayload = new TextDecoder().decode(decryptedBytes);
					}
					const decryptedMessage = { ...message, payload: decryptedPayload };
					// console.log("Decryption successful, emitting message:", decryptedMessage); // Optional: Verbose logging
					this.emit(EncryptedWsClient.Events.Message, decryptedMessage);
				} else {
					console.error("E2EE Decryption failed (tag mismatch?) for message:", message.id);
					this.emit(EncryptedWsClient.Events.Error, new Error(`Decryption failed for message ${message.id}`));
					 this.setState('pairing_failed');
					 this.disconnect();
				}
			} catch (error) {
				console.error("Error during E2EE decryption or parsing:", error);
				this.emit(EncryptedWsClient.Events.Error, new Error(`Decryption processing error for message ${message.id}`));
				 this.setState('pairing_failed');
				 this.disconnect();
			}
		} else if (this.state !== 'paired' && message.payload?.nonce && message.payload?.ciphertext) {
			 console.warn("Received encrypted message but E2EE state is not 'paired'. State:", this.state, "Msg ID:", message.id);
		} else {
			 // Message is not E2EE-related or not encrypted
			 if (this.state === 'paired') {
				 console.warn("Received unencrypted message while in 'paired' state:", message);
			 }
			 // Emit the original message for the application
			 // console.log("Emitting non-encrypted message:", message); // Optional: Verbose logging
			 this.emit(EncryptedWsClient.Events.Message, message);
		}
	}

	private async handleE2EEMessage(message: WsMessage) {
		if (!message.action || !message.payload) {
			console.warn("Received invalid E2EE message:", message);
			return;
		}
		 console.log(`Received E2EE message (WebUI): Action=${message.action}, State=${this.state}`, message.payload); // Log payload

		switch (message.action) {
			case E2EE_PUBKEY_EXCHANGE:
				if (this.state === 'requesting_pairing' || this.state === 'checking_pairing' || this.state === 'awaiting_peer_pubkey') {
					 const { publicKey: peerKeyHex, deviceId: peerDeviceId } = message.payload as E2EEPayloadPubKey;
					 if (!peerKeyHex || typeof peerKeyHex !== 'string' || !peerDeviceId || typeof peerDeviceId !== 'string') {
						 console.error("Invalid pubkey exchange payload.");
						  this.setState('pairing_failed');
						 return;
					 }
					 try {
						 this.peerPublicKey = hexToBytes(peerKeyHex);
						 this.peerDeviceId = peerDeviceId;
						 console.log(`Received and stored public key from Extension: ${this.peerDeviceId}`);

						 // Scenario 1: Re-pairing (we were awaiting peer key after sending ours)
						 if (this.state === 'awaiting_peer_pubkey') {
						  console.log("handleE2EEMessage(PUBKEY): Received peer pubkey during re-pairing flow.");
						  const keysOk = await this.computeSessionKeys(); // Compute keys first
						  if(keysOk) { // Check if keys were derived successfully
							 	this.setState('paired');
							 	console.log("E2EE Re-established. Secure channel active.");
							 } else {
								 console.error("Failed to derive session keys during re-pairing.");
								 this.setState('pairing_failed');
							 }
						 }
						 // Scenario 2: First time pairing (we sent request, now got peer key)
						 else if (this.state === 'requesting_pairing') {
							 console.log("handleE2EEMessage(PUBKEY): Received peer pubkey during initial pairing flow.");
							 await this.sendPublicKey(); // Send our key back
							 this.setState('awaiting_pairing_code'); // Transition to wait for user code
							 console.log("Emitting PairingRequired event.");
							 this.emit(EncryptedWsClient.Events.PairingRequired);
						 }
						 // Scenario 3: Checking pairing (we found stored key, sent ours, now got theirs back)
						 else if (this.state === 'checking_pairing') {
							 console.warn("Received pubkey while still in checking_pairing state. Treating as re-pairing.");
							 await this.computeSessionKeys();
							 if(this.txKey && this.rxKey) {
							 	this.setState('paired');
							 	console.log("E2EE Re-established (from checking_pairing). Secure channel active.");
							 } else {
								 console.error("Failed to derive session keys during re-pairing (from checking).");
								 this.setState('pairing_failed');
							 }
						 }
					 } catch (e) {
						 console.error("Failed to parse peer public key hex:", e);
						  this.setState('pairing_failed');
					 }
				 } else {
					  console.warn(`Ignoring ${E2EE_PUBKEY_EXCHANGE} in state ${this.state}`);
				 }
				break;

			// Note: Web UI does not receive E2EE_VERIFY. Confirmation is implicit.

			default:
				console.warn("Received unknown E2EE action:", message.action);
		}
	}

	private async sendPublicKey() {
		if (!this.ownKeyPair) {
			console.error("Cannot send public key: Own key pair not available.");
			return;
		}
		console.log("Sending own public key to extension."); // Added logging
		const payload: E2EEPayloadPubKey = {
			publicKey: bytesToHex(this.ownKeyPair.publicKey),
			deviceId: await this.keyStorage.getDeviceId()
		};
		await this.sendE2EEMessage(E2EE_PUBKEY_EXCHANGE, payload);
	}

	 private async computeSessionKeys(sharedSecret?: Uint8Array): Promise<boolean> { // Return boolean success
	  console.log("computeSessionKeys: Attempting..."); // Log entry
	  if (!this.ownKeyPair || !this.peerPublicKey || !this.sodiumInstance) {
	 	 console.error("computeSessionKeys: Cannot compute session keys - Missing keys or sodium instance.", { hasOwnKey: !!this.ownKeyPair, hasPeerKey: !!this.peerPublicKey, hasSodium: !!this.sodiumInstance });
	 	 this.setState('pairing_failed');
	 	 return false; // Indicate failure
		 }

		 try {
			 console.log("Computing session keys..."); // Added logging
			 const secret = sharedSecret ?? computeSharedSecret(this.ownKeyPair.privateKey, this.peerPublicKey);
			 const keyLength = this.sodiumInstance.crypto_aead_chacha20poly1305_ietf_KEYBYTES;
			 const context = "RooE2EE_v1";

			 const { txKey: derivedTxKey, rxKey: derivedRxKey } = await deriveKeys(secret, keyLength, context);

			 // WebUI Tx uses key derived with ID 2 (matches Ext Rx)
			 // WebUI Rx uses key derived with ID 1 (matches Ext Tx)
			 this.rxKey = derivedTxKey; // Derived with ID 1
			 this.txKey = derivedRxKey; // Derived with ID 2
			 console.log("computeSessionKeys: Session keys derived successfully."); // Log success

			 // If we were waiting for verification, transition to paired *only if* verification succeeds implicitly.
			 // Transition to paired state *after* successful key derivation
			 // This happens in both initial pairing (after verification) and re-pairing flows.
			 if (this.state === 'awaiting_verification' || this.state === 'awaiting_peer_pubkey' || this.state === 'checking_pairing') {
				 console.log(`computeSessionKeys: State is ${this.state}, proceeding to save peer key and set state to 'paired'.`);
				 await this.keyStorage.savePeerPublicKey(this.peerDeviceId!, this.peerPublicKey);
				 this.setState('paired'); // Set state *after* saving key
				 console.log("E2EE Pairing Complete (WebUI). Secure channel established.");
			 }
			 return true; // Indicate success

		 } catch (error) {
			 console.error("computeSessionKeys: Failed to derive session keys:", error); // Log error
			 this.setState('pairing_failed');
			 this.txKey = null; // Clear keys on failure
			 this.rxKey = null;
			 return false; // Indicate failure
		 }
	 }

	// Helper to send E2EE control messages
	private sendE2EEMessage(action: string, payload: any): Promise<void> {
		const message: WsMessage = {
			type: 'e2ee',
			action: action,
			payload: payload,
		};
		// console.log("Sending E2EE message:", message); // Optional: Verbose logging
		return this.underlyingClient.send(message);
	}
}

// Helper function to get the singleton instance if needed
let instance: EncryptedWsClient | null = null;
export function getEncryptedWsClient(): EncryptedWsClient {
	if (!instance) {
		instance = new EncryptedWsClient();
	}
	return instance;
}