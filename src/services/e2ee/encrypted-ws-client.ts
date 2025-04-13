// src/services/e2ee/encrypted-ws-client.ts
import { EventEmitter } from "events";
import * as vscode from "vscode";
import { WebSocketClient } from "../websocket/client";
import { WebSocketConfig, WebSocketMessage } from "../websocket/types";
import { EncryptionService } from "./encryption";
import { PairingService, PairingState } from "./pairing";
import { arrayBufferToBase64, base64ToArrayBuffer } from "../../utils/base64"; // Revert to original relative path

// Extend the message structure for E2EE
interface EncryptedWebSocketMessage extends WebSocketMessage {
    payload?: {
        encrypted?: boolean;
        data?: string; // Base64 encoded ciphertext
        nonce?: string; // Base64 encoded nonce
    } | any; // Allow original payload structure if not encrypted
    peerPublicKey?: string; // Sender's public key for decryption key lookup
}

export class EncryptedWebSocketClient extends EventEmitter {
    private baseClient: WebSocketClient;
    private encryptionService: EncryptionService;
    private pairingService: PairingService;
    private peerPublicKeyString: string | null = null; // Track the paired peer

    constructor(config: WebSocketConfig, context: vscode.ExtensionContext) {
        super();
        this.baseClient = new WebSocketClient(config);
        this.encryptionService = new EncryptionService(context);
        // Pass 'this' (the wrapper) to PairingService so it can send internal messages
        this.pairingService = new PairingService(this.encryptionService, this);

        this.setupEventForwarding();
        this.setupE2EEHandlers();
    }

    async initialize(): Promise<void> {
        await this.encryptionService.init();
        // TODO: Load pairing state (e.g., check if already paired with someone)
        // For now, assume starting unpaired
        this.pairingService.resetPairing();
    }

    private setupEventForwarding(): void {
        // Forward connection status events
        this.baseClient.on("connecting", () => this.emit("connecting"));
        this.baseClient.on("connected", () => this.emit("connected"));
        this.baseClient.on("disconnected", () => {
            this.peerPublicKeyString = null; // Reset peer on disconnect
            this.pairingService.resetPairing();
            this.emit("disconnected");
        });
        this.baseClient.on("error", (err) => this.emit("error", err));

        // Intercept and handle messages
        this.baseClient.on("message", (message: WebSocketMessage) => {
            this.handleIncomingMessage(message as EncryptedWebSocketMessage);
        });

        // Forward pairing events
        this.pairingService.on("state-change", (state) => this.emit("pairing-state-change", state));
        this.pairingService.on("pairing-code", (code) => this.emit("pairing-code", code));
        this.pairingService.on("paired", (peerKey) => {
            this.peerPublicKeyString = peerKey;
            this.emit("paired", peerKey);
        });
    }

    private setupE2EEHandlers(): void {
        // Listen for internal E2EE messages (handled by PairingService)
        // These are identified by specific 'type' values
    }

    private async handleIncomingMessage(message: EncryptedWebSocketMessage): Promise<void> {
        console.log("EncryptedClient received:", message.type);

        // Handle E2EE control messages
        switch (message.type) {
            case "E2EE_PUBKEY":
                if (message.payload?.publicKey) {
                    await this.pairingService.handlePeerPublicKey(message.payload.publicKey);
                } else {
                    console.warn("Received E2EE_PUBKEY without key");
                }
                return; // Don't forward E2EE control messages
            case "E2EE_CONFIRM":
                await this.pairingService.handleConfirmation();
                return; // Don't forward E2EE control messages
            case "connection-info": // Server message, might contain peer info if needed later
                 // Store peer public key if provided by server? (Alternative pairing initiation)
                 this.emit("message", message); // Forward connection info
                 return;
            case "acknowledge":
            case "error":
                 this.emit("message", message); // Forward simple server messages
                 return;
        }

        // Handle potentially encrypted application messages
        let decryptedPayload = message.payload;
        if (message.payload?.encrypted && message.payload?.data && message.payload?.nonce && message.peerPublicKey) {
            console.log("Decrypting payload for message:", message.id);
            try {
                const ciphertext = base64ToArrayBuffer(message.payload.data);
                // Convert nonce ArrayBuffer to Uint8Array for the decrypt function
                const nonce = new Uint8Array(base64ToArrayBuffer(message.payload.nonce));
                decryptedPayload = await this.encryptionService.decrypt(message.peerPublicKey, { ciphertext, nonce });
                if (decryptedPayload === null) {
                    console.error("Decryption failed for message:", message.id);
                    // TODO: Handle decryption failure (e.g., emit error, notify user?)
                    return; // Don't forward corrupted message
                }
            } catch (error) {
                 console.error("Error during decryption:", error);
                 return; // Don't forward if decryption throws
            }
        } else if (message.payload?.encrypted) {
            console.warn("Received message marked encrypted but missing data/nonce/peerKey:", message.id);
            return; // Don't forward incomplete encrypted message
        }

        // Forward the message with the (potentially decrypted) payload
        const finalMessage: WebSocketMessage = {
            ...message,
            payload: decryptedPayload,
        };
        this.emit("message", finalMessage);
    }

    // Public connect method
    connect(): Promise<void> {
        return this.baseClient.connect();
    }

    // Public disconnect method
    disconnect(): void {
        this.baseClient.disconnect();
    }

    // Send application messages (will be encrypted if paired)
    async send(message: Omit<WebSocketMessage, "id">): Promise<void> {
        if (this.pairingService.getState() !== "paired" || !this.peerPublicKeyString) {
            console.warn("Cannot send application message: Not paired.");
            // Or maybe queue? For now, just drop/warn.
            // Alternatively, allow sending unencrypted if not paired? Depends on requirements.
            // Let's assume for now we ONLY send encrypted messages after pairing.
             throw new Error("Cannot send message: Client is not paired.");
            // If allowing unencrypted:
            // return this.baseClient.send({ ...message, clientType: 'extension' });
        }

        const encryptionResult = await this.encryptionService.encrypt(this.peerPublicKeyString, message.payload);
        if (!encryptionResult) {
            console.error("Failed to encrypt payload for message:", message.type);
            throw new Error("Encryption failed.");
        }

        const encryptedPayload = {
            encrypted: true,
            data: arrayBufferToBase64(encryptionResult.ciphertext),
            nonce: arrayBufferToBase64(encryptionResult.nonce),
        };

        const encryptedMessage: EncryptedWebSocketMessage = {
            ...message,
            clientType: 'extension', // Ensure clientType is set
            payload: encryptedPayload,
            peerPublicKey: await this.encryptionService.getPublicKeyString() ?? undefined, // Send our key for identification
        };

        return this.baseClient.send(encryptedMessage); // Send via the base client
    }

    // Send internal E2EE control messages (never encrypted)
    sendInternal(message: Omit<WebSocketMessage, "id">): Promise<void> {
        console.log("Sending internal E2EE message:", message.type);
        // Ensure clientType is set and typed correctly
        const internalMessage: WebSocketMessage = {
        	...message,
        	clientType: 'extension' // Explicitly assigning to the correct type field
        };
        return this.baseClient.send(internalMessage);
    }

    // --- Pairing Control ---
    initiatePairing(): Promise<void> {
        return this.pairingService.initiatePairing();
    }

    confirmPairing(): Promise<void> {
        return this.pairingService.confirmPairing();
    }

    getPairingState(): PairingState {
        return this.pairingService.getState();
    }

    getPairingCode(): string | null {
        return this.pairingService.getPairingCode();
    }
} // Trivial change 2