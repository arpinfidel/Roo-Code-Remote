// webview-ui/src/lib/e2ee/encrypted-ws-client.ts
import { WsClient, WsMessage } from "../ws-client"; // Base client
import { EncryptionService, PAIRED_KEYS_STORAGE_KEY_PREFIX } from "./encryption"; // Import constant
import { PairingService, PairingState } from "./pairing";
import { arrayBufferToBase64, base64ToArrayBuffer } from "../utils/base64";

// Define message types consistent with src/services/websocket/types.ts
// Ideally, these would be shared types.
// Export the type for use in context
export type WebSocketMessageType =
    | "command"
    | "response"
    | "event"
    | "vscode-message"
    | "vscode-event"
    | "client-connected"
    | "connection-info"
    | "acknowledge"
    | "error"
    | "E2EE_PUBKEY"
    | "E2EE_CONFIRM";

interface EncryptedPayload {
    encrypted: true;
    data: string; // Base64 encoded ciphertext
    nonce: string; // Base64 encoded nonce
}

interface E2EEWebSocketMessage extends WsMessage {
    id: string; // Add missing ID property (inherited from WsMessage, but make explicit)
    type: WebSocketMessageType; // Use the extended type
    payload?: EncryptedPayload | any; // Allow encrypted or regular payload
    peerPublicKey?: string; // Sender's public key for E2EE
    clientType?: "webui" | "extension";
}

// Configuration for the encrypted client
interface EncryptedWsClientConfig {
    url: string;
    clientType: "webui" | "extension";
    sessionId: string | null;
    authToken: string | null;
}

export class EncryptedWsClient extends EventTarget {
    private baseClient: WsClient;
    private encryptionService: EncryptionService;
    private pairingService: PairingService;
    private peerPublicKeyString: string | null = null; // Track the paired peer
    // Make config accessible within the class, but not intended for external modification
    protected config: EncryptedWsClientConfig;

    constructor(config: EncryptedWsClientConfig) {
        super();
        this.config = config;
        this.baseClient = new WsClient();
        this.encryptionService = new EncryptionService();
        // Pass 'this' (the wrapper) to PairingService
        this.pairingService = new PairingService(this.encryptionService, this);

        this.setupEventForwarding();
    }

    async initialize(): Promise<void> {
        await this.encryptionService.init();
        // Check local storage if already paired?
        const storedPeerKey = Object.keys(localStorage).find(k => k.startsWith("e2ee.pairedKey."))?.substring("e2ee.pairedKey.".length);
        if (storedPeerKey) {
             console.log("Found existing paired key for peer:", storedPeerKey.substring(0, 10) + "...");
             this.peerPublicKeyString = storedPeerKey;
             // Ensure the key is loaded into the service map if not already
             if (!this.encryptionService.getEncryptionKey(storedPeerKey)) {
                 await this.encryptionService.loadPairedKeys(); // Reload specific key if needed
             }
             if (this.encryptionService.getEncryptionKey(storedPeerKey)) {
                 this.pairingService.setState("paired"); // Set initial state if key exists
                 this.emit("paired", storedPeerKey);
             } else {
                 console.warn("Stored peer key found, but failed to load encryption key.");
                 localStorage.removeItem("e2ee.pairedKey." + storedPeerKey); // Clean up bad key
                 this.pairingService.resetPairing(false); // Reset without notification
             }
        } else {
            this.pairingService.resetPairing(false); // Start unpaired, no notification needed
        }
    }

    private setupEventForwarding(): void {
        // Forward connection status events
        this.baseClient.on("connected", () => this.emit("connected"));
        this.baseClient.on("disconnected", (event) => {
            // Don't automatically reset pairing on temporary disconnects if key exists
            // Only reset if connection closes uncleanly or explicitly unpaired
            console.log("Base client disconnected:", event.detail);
            this.emit("disconnected", event.detail);
            // Consider if pairing should be reset here or handled differently
        });
        this.baseClient.on("error", (event) => this.emit("error", event.detail));

        // Intercept and handle messages
        this.baseClient.on("message", (event) => {
            this.handleIncomingMessage(event.detail as E2EEWebSocketMessage);
        });

        // Forward pairing events
        this.pairingService.addEventListener("state-change", (event) => this.emit("pairing-state-change", (event as CustomEvent).detail));
        this.pairingService.addEventListener("pairing-code", (event) => this.emit("pairing-code", (event as CustomEvent).detail));
        this.pairingService.addEventListener("paired", (event) => {
            this.peerPublicKeyString = (event as CustomEvent).detail;
            this.emit("paired", this.peerPublicKeyString);
        });
         this.pairingService.addEventListener("unpaired", () => {
            this.peerPublicKeyString = null;
            this.emit("unpaired");
        });
         this.pairingService.addEventListener("error", (event) => this.emit("error", (event as CustomEvent).detail)); // Forward pairing errors
    }

    private async handleIncomingMessage(message: E2EEWebSocketMessage): Promise<void> {
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
            case "connection-info":
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
                const nonce = new Uint8Array(base64ToArrayBuffer(message.payload.nonce)); // Ensure Uint8Array
                decryptedPayload = await this.encryptionService.decrypt(message.peerPublicKey, { ciphertext, nonce });
                if (decryptedPayload === null) {
                    console.error("Decryption failed for message:", message.id);
                    this.emit("error", new Error(`Decryption failed for message ${message.id}`));
                    return; // Don't forward corrupted message
                }
            } catch (error) {
                 console.error("Error during decryption:", error);
                 this.emit("error", new Error(`Decryption error: ${error}`));
                 return; // Don't forward if decryption throws
            }
        } else if (message.payload?.encrypted) {
            console.warn("Received message marked encrypted but missing data/nonce/peerKey:", message.id);
            return; // Don't forward incomplete encrypted message
        }

        // Forward the message with the (potentially decrypted) payload
        const finalMessage: E2EEWebSocketMessage = {
            ...message,
            payload: decryptedPayload,
        };
        this.emit("message", finalMessage);
    }

    // Public connect method
    connect(): Promise<void> {
        this.baseClient
            .setURL(this.config.url)
            .setClientType(this.config.clientType)
            .setSessionId(this.config.sessionId)
            .setAuthToken(this.config.authToken);
        return this.baseClient.connect();
       }
      
       // Method to update auth token before connecting
       setAuthToken(token: string | null): void {
        this.config.authToken = token;
        // Also update the base client if it's already configured and needs it directly
        // (Assuming baseClient uses config passed during its connect call)
       }

    // Public disconnect method
    disconnect(): void {
        this.baseClient.disconnect();
    }

    // Send application messages (will be encrypted if paired)
    async send(message: Omit<E2EEWebSocketMessage, "id" | "clientType" | "peerPublicKey">): Promise<void> {
        if (this.pairingService.getState() !== "paired" || !this.peerPublicKeyString) {
            console.warn("Cannot send application message: Not paired.");
             throw new Error("Cannot send message: Client is not paired.");
        }

        const encryptionResult = await this.encryptionService.encrypt(this.peerPublicKeyString, message.payload);
        if (!encryptionResult) {
            console.error("Failed to encrypt payload for message:", message.type);
            throw new Error("Encryption failed.");
        }

        const encryptedPayload: EncryptedPayload = {
            encrypted: true,
            data: arrayBufferToBase64(encryptionResult.ciphertext),
            // Use slice() on the Uint8Array to get a new ArrayBuffer guaranteed not to be SharedArrayBuffer
            nonce: arrayBufferToBase64(encryptionResult.nonce.slice().buffer),
        };

        const ownPublicKey = await this.encryptionService.getPublicKeyString();
        if (!ownPublicKey) {
             console.error("Failed to get own public key for sending.");
             throw new Error("Missing own public key.");
        }

        const encryptedMessage: Omit<E2EEWebSocketMessage, "id"> = {
            ...message,
            clientType: this.config.clientType,
            payload: encryptedPayload,
            peerPublicKey: ownPublicKey, // Send our key for identification
        };

        return this.baseClient.send(encryptedMessage); // Send via the base client
    }

    // Send internal E2EE control messages (never encrypted)
    sendInternal(message: Omit<E2EEWebSocketMessage, "id" | "clientType" | "peerPublicKey">): Promise<void> {
        console.log("Sending internal E2EE message:", message.type);
        const internalMessage: Omit<E2EEWebSocketMessage, "id"> = {
             ...message,
             clientType: this.config.clientType,
             // No peerPublicKey needed for internal messages like PUBKEY/CONFIRM
        };
        return this.baseClient.send(internalMessage);
    }

    // --- Pairing Control ---
    initiatePairing(): Promise<void> {
        return this.pairingService.initiatePairing();
    }

    confirmPairing(): Promise<void> {
        return this.pairingService.confirmPairing();
    } // Trivial change

    resetPairing(): void {
        // Clear stored keys associated with pairing
        if (this.peerPublicKeyString) {
             localStorage.removeItem(PAIRED_KEYS_STORAGE_KEY_PREFIX + this.peerPublicKeyString);
        }
        this.pairingService.resetPairing(); // Resets state and notifies
    }

    getPairingState(): PairingState {
        return this.pairingService.getState();
    }

    getPairingCode(): string | null {
        return this.pairingService.getPairingCode();
    }

    // --- Event Emitter ---
    emit(type: string, detail?: any) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}

// Removed unnecessary declare module block