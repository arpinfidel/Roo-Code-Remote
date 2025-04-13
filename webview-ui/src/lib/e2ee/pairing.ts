// webview-ui/src/lib/e2ee/pairing.ts
import { EncryptionService } from "./encryption";
import { EncryptedWsClient } from "./encrypted-ws-client"; // Revert: Remove .ts extension

// TODO: Implement pairing code generation (e.g., from shared secret)
// Could use a library like noble-hashes if added, or implement simple hash+modulo

export type PairingState =
    | "unpaired"
    | "initiating" // Sent our key, waiting for peer's key
    | "awaiting-confirmation" // Received peer key, derived secret, showing code
    | "confirming" // User confirmed, sending confirmation
    | "paired";

export class PairingService extends EventTarget { // Use EventTarget for browser events
    private state: PairingState = "unpaired";
    private peerPublicKeyString: string | null = null;
    private peerPublicKey: CryptoKey | null = null;
    private pairingCode: string | null = null;
    private sharedSecret: ArrayBuffer | null = null; // Keep temporarily for code generation

    constructor(
        private encryptionService: EncryptionService,
        private wsClient: EncryptedWsClient // Use the wrapper
    ) {
        super();
    }

    getState(): PairingState {
        return this.state;
    }

    getPairingCode(): string | null {
        return this.pairingCode;
    }

    // Called when user initiates pairing (e.g., clicks button)
    async initiatePairing(): Promise<void> {
        if (this.state !== "unpaired") {
            console.warn("Pairing already in progress or completed.");
            return;
        }
        console.log("Initiating E2EE pairing...");
        this.setState("initiating");

        const publicKeyString = await this.encryptionService.getPublicKeyString();
        if (!publicKeyString) {
            console.error("Failed to get public key string.");
            this.setState("unpaired"); // Revert state
            this.emit("error", new Error("Failed to get public key"));
            return;
        }

        // Send our public key to the peer
        this.wsClient.sendInternal({
            type: "E2EE_PUBKEY",
            payload: { publicKey: publicKeyString },
        });
    }

    // Called when an E2EE_PUBKEY message is received
    async handlePeerPublicKey(peerKeyString: string): Promise<void> {
        console.log("Received peer public key.");
        this.peerPublicKeyString = peerKeyString;

        this.peerPublicKey = await this.encryptionService.importPublicKey(peerKeyString);
        if (!this.peerPublicKey) {
            console.error("Failed to import peer public key.");
            this.emit("error", new Error("Failed to import peer public key"));
            this.resetPairing();
            return;
        }

        // Derive shared secret (using deriveBits directly might be simpler here than full deriveKey)
        const privateKey = this.encryptionService.getPrivateKey();
        if (!privateKey) { // Need access to private key
             console.error("Private key not loaded for secret derivation.");
             this.resetPairing();
             return;
        }
        try {
             this.sharedSecret = await window.crypto.subtle.deriveBits(
                { name: "ECDH", public: this.peerPublicKey },
                privateKey, // Use the fetched private key
                256 // Derive 256 bits
            );
        } catch(error) {
            console.error("Failed to derive shared secret:", error);
            this.resetPairing();
            return;
        }


        if (!this.sharedSecret) {
            console.error("Failed to derive shared secret (result was null).");
            this.resetPairing();
            return;
        }

        // Generate pairing code from shared secret
        this.pairingCode = this.generatePairingCode(this.sharedSecret);

        this.setState("awaiting-confirmation");
        this.emit("pairing-code", this.pairingCode); // Notify UI to display code

        // If we initiated, we wait for confirmation. If the peer initiated, we send our key back.
        if (this.state === "initiating") {
            // We already sent our key, now just wait for E2EE_CONFIRM
            console.log("Pairing initiated by us, awaiting confirmation from peer.");
        } else {
             console.log("Pairing initiated by peer, sending our public key back.");
            // Peer initiated, send our public key back now
            const publicKeyString = await this.encryptionService.getPublicKeyString();
            if (publicKeyString) {
                this.wsClient.sendInternal({
                    type: "E2EE_PUBKEY",
                    payload: { publicKey: publicKeyString },
                });
            } else {
                console.error("Failed to get own public key to send back.");
                this.resetPairing();
            }
        }
    }

    // Called when an E2EE_CONFIRM message is received
    async handleConfirmation(): Promise<void> {
        if (this.state !== "awaiting-confirmation" || !this.peerPublicKeyString || !this.peerPublicKey) {
            console.warn("Received unexpected confirmation or missing keys.");
            // Allow confirmation even if sharedSecret is cleared (e.g., page refresh)
            // We re-derive the AES key using stored keys if needed.
            // return;
        }
        console.log("Pairing confirmed by peer.");

        // Ensure peer public key is available
         if (!this.peerPublicKey) {
             this.peerPublicKey = await this.encryptionService.importPublicKey(this.peerPublicKeyString!);
             if (!this.peerPublicKey) {
                 console.error("Failed to re-import peer public key for confirmation.");
                 this.resetPairing();
                 return;
             }
         }


        // Derive and store the persistent encryption key
        const aesKey = await this.encryptionService.deriveAndStoreEncryptionKey(this.peerPublicKeyString!, this.peerPublicKey);
        if (!aesKey) {
            console.error("Failed to derive/store final encryption key during confirmation.");
            this.resetPairing(); // Fail pairing if key derivation fails
            return;
        }

        this.sharedSecret = null; // Clear temporary secret
        this.pairingCode = null;
        this.setState("paired");
        this.emit("paired", this.peerPublicKeyString); // Notify system pairing is complete
    }

    // Called when the *local* user confirms the code matches
    async confirmPairing(): Promise<void> {
         if (this.state !== "awaiting-confirmation" || !this.peerPublicKeyString || !this.peerPublicKey) {
            console.warn("Cannot confirm pairing in current state or missing keys.");
             // Allow confirmation even if sharedSecret is cleared (e.g., page refresh)
             // We re-derive the AES key using stored keys if needed.
            // return;
        }
         console.log("Local user confirmed pairing code.");

         // Ensure peer public key is available
         if (!this.peerPublicKey) {
             this.peerPublicKey = await this.encryptionService.importPublicKey(this.peerPublicKeyString!);
             if (!this.peerPublicKey) {
                 console.error("Failed to re-import peer public key for confirmation.");
                 this.resetPairing(); // Don't proceed if key import fails
                 return;
             }
         }

        this.setState("confirming");

        // Send confirmation message to peer
        this.wsClient.sendInternal({ type: "E2EE_CONFIRM" });

        // Derive and store the persistent encryption key
        const aesKey = await this.encryptionService.deriveAndStoreEncryptionKey(this.peerPublicKeyString!, this.peerPublicKey);
         if (!aesKey) {
            console.error("Failed to derive/store final encryption key during confirmation.");
            this.resetPairing(); // Fail pairing if key derivation fails
            return;
        }

        this.sharedSecret = null; // Clear temporary secret
        this.pairingCode = null;
        this.setState("paired");
        this.emit("paired", this.peerPublicKeyString); // Notify system pairing is complete
    }


    resetPairing(notify: boolean = true): void {
        console.log("Resetting pairing state.");
        const wasPaired = this.state === "paired";
        this.peerPublicKeyString = null;
        this.peerPublicKey = null;
        this.sharedSecret = null;
        this.pairingCode = null;
        this.setState("unpaired");
        if (wasPaired && notify) {
            this.emit("unpaired"); // Notify if we were previously paired
        }
    }

    // Make public for wrapper initialization, but treat as internal
    public setState(newState: PairingState): void {
        if (this.state !== newState) {
            console.log(`Pairing state changed: ${this.state} -> ${newState}`);
            this.state = newState;
            this.emit("state-change", newState);
        }
    }

    // --- Event Emitter ---
    emit(type: string, detail?: any) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    // --- Helper Functions (TODO: Implement using crypto libraries) ---

    private generatePairingCode(secret: ArrayBuffer): string {
        // TODO: Use HKDF or hash to derive a short, user-friendly code
        // Example using noble-hashes (needs installation):
        // const info = new TextEncoder().encode('pairing-code');
        // const okm = hkdf(sha256, new Uint8Array(secret), undefined, info, 6); // Get 6 bytes
        // const codeNum = bytesToNumberBE(okm) % 1000000; // Get number 0-999999
        // return codeNum.toString().padStart(6, '0');

        // Simple placeholder using first few bytes of secret (NOT SECURE FOR PRODUCTION)
        const secretBytes = new Uint8Array(secret);
        let codeNum = 0;
        for (let i = 0; i < 3; i++) { // Use 3 bytes
             codeNum = (codeNum << 8) | secretBytes[i];
        }
        return (codeNum % 1000000).toString().padStart(6, '0');
    }
}

// Removed the conflicting declare module block