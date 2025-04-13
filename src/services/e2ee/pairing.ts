// src/services/e2ee/pairing.ts
import { EventEmitter } from "events";
import { EncryptionService } from "./encryption";
import { EncryptedWebSocketClient } from "./encrypted-ws-client";
import { webcrypto as crypto } from "node:crypto"; // For randomValues and TextEncoder if needed

// TODO: Consider using a more robust pairing code generation (e.g., HKDF) for production
// import { hkdf } from '@noble/hashes/hkdf'; // Example dependency
// import { sha256 } from '@noble/hashes/sha256';
// import { bytesToNumberBE } from '@noble/curves/abstract/utils';

export type PairingState =
    | "unpaired"
    | "initiating" // Sent our key, waiting for peer's key
    | "awaiting-confirmation" // Received peer key, derived secret, showing code
    | "confirming" // User confirmed, sending confirmation
    | "paired";

export class PairingService extends EventEmitter {
    private state: PairingState = "unpaired";
    private peerPublicKeyString: string | null = null;
    private peerPublicKey: CryptoKey | null = null;
    private pairingCode: string | null = null;
    private sharedSecret: ArrayBuffer | null = null; // Keep temporarily for code generation

    constructor(
        private encryptionService: EncryptionService,
        private wsClient: EncryptedWebSocketClient // Use the wrapper
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
            // TODO: Emit error event
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

        // Import the peer's public key
        this.peerPublicKey = await this.encryptionService.importPublicKey(peerKeyString);
        if (!this.peerPublicKey) {
            console.error("Failed to import peer public key.");
            this.emit("error", new Error("Failed to import peer public key"));
            this.resetPairing();
            return;
        }

        // Derive shared secret bits directly for pairing code generation
        const privateKey = this.encryptionService.getPrivateKey();
        if (!privateKey) {
            console.error("Private key not loaded for secret derivation.");
            this.resetPairing();
            return;
        }
        try {
             this.sharedSecret = await crypto.subtle.deriveBits(
                { name: "ECDH", public: this.peerPublicKey },
                privateKey,
                256 // Derive 256 bits
            );
        } catch(error) {
            console.error("Failed to derive shared secret:", error);
            this.resetPairing();
            return;
        }

        if (!this.sharedSecret) { // Should not happen if deriveBits succeeds, but check anyway
            console.error("Failed to derive shared secret.");
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
        } else {
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
        if (this.state !== "awaiting-confirmation" || !this.peerPublicKeyString || !this.peerPublicKey || !this.sharedSecret) {
            console.warn("Received unexpected confirmation or missing keys/secret.");
            return;
        }
        console.log("Pairing confirmed by peer.");

        // Ensure peer public key is available (might have been lost if service restarted)
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
         if (this.state !== "awaiting-confirmation" || !this.peerPublicKeyString || !this.peerPublicKey || !this.sharedSecret) {
            console.warn("Cannot confirm pairing in current state or missing keys/secret.");
            return;
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


    resetPairing(): void {
        console.log("Resetting pairing state.");
        this.peerPublicKeyString = null;
        this.peerPublicKey = null;
        this.sharedSecret = null;
        this.pairingCode = null;
        this.setState("unpaired");
    }

    private setState(newState: PairingState): void {
        if (this.state !== newState) {
            console.log(`Pairing state changed: ${this.state} -> ${newState}`);
            this.state = newState;
            this.emit("state-change", newState);
        }
    }

    // --- Helper Functions ---

    // No longer needed here, moved to EncryptionService
    // private async importPublicKey(keyString: string): Promise<CryptoKey | null> { ... }

    private generatePairingCode(secret: ArrayBuffer): string {
        // Simple placeholder using first few bytes of secret (NOT SECURE FOR PRODUCTION)
        // Consider using HKDF or a similar KDF for better distribution.
        const secretBytes = new Uint8Array(secret);
        let codeNum = 0;
        // Combine 3 bytes into a number
        for (let i = 0; i < 3; i++) {
             codeNum = (codeNum << 8) | secretBytes[i];
        }
        // Take modulo 1,000,000 and pad with leading zeros
        return (codeNum % 1000000).toString().padStart(6, '0');
    }
}