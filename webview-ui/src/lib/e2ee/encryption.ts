// webview-ui/src/lib/e2ee/encryption.ts

import { arrayBufferToBase64, base64ToArrayBuffer } from "../utils/base64";

const E2EE_KEY_STORAGE_KEY = "e2ee.privateKey"; // Store JWK string in localStorage
const PUBLIC_KEY_STORAGE_KEY = "e2ee.publicKey"; // Store JWK string in localStorage
export const PAIRED_KEYS_STORAGE_KEY_PREFIX = "e2ee.pairedKey."; // Prefix + peerPublicKeyString -> Stores AES JWK string

// TODO: Implement cryptographic functions using SubtleCrypto (available in browser)
// - generateKeyPair (ECDH P-256)
// - storePrivateKey (using localStorage, store as JWK string)
// - loadPrivateKey
// - deriveSharedSecret (ECDH)
// - deriveEncryptionKey (HKDF from shared secret -> AES-GCM key)
// - storeEncryptionKey (associated with peer public key, store as JWK string)
// - loadEncryptionKey
// - encryptPayload (AES-GCM) -> { ciphertext: ArrayBuffer, nonce: Uint8Array }
// - decryptPayload (AES-GCM)

export class EncryptionService {
    private privateKey: CryptoKey | null = null;
    private publicKey: CryptoKey | null = null;
    private pairedKeys: Map<string, CryptoKey> = new Map(); // Map<peerPublicKeyString, AESKey>

    // Removed empty constructor

    async init(): Promise<void> {
        console.log("Initializing WebUI EncryptionService...");
        await this.loadKeys();
        if (!this.privateKey || !this.publicKey) {
            console.log("No keys found, generating new ones...");
            await this.generateAndStoreKeys();
        } else {
            console.log("E2EE keys loaded successfully.");
        }
        await this.loadPairedKeys();
    }

    // --- Key Management ---

    async generateAndStoreKeys(): Promise<void> {
        try {
            const keyPair = await window.crypto.subtle.generateKey(
                { name: "ECDH", namedCurve: "P-256" },
                true, // Exportable
                ["deriveKey", "deriveBits"]
            );

            this.privateKey = keyPair.privateKey;
            this.publicKey = keyPair.publicKey;

            // Store keys as JWK strings in localStorage
            const privateJwk = await window.crypto.subtle.exportKey("jwk", this.privateKey);
            const publicJwk = await window.crypto.subtle.exportKey("jwk", this.publicKey);

            localStorage.setItem(E2EE_KEY_STORAGE_KEY, JSON.stringify(privateJwk));
            localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, JSON.stringify(publicJwk));

            console.log("New E2EE key pair generated and stored.");
        } catch (error) {
            console.error("Error generating/storing keys:", error);
        }
    }

    async loadKeys(): Promise<void> {
        try {
            const privateJwkStr = localStorage.getItem(E2EE_KEY_STORAGE_KEY);
            const publicJwkStr = localStorage.getItem(PUBLIC_KEY_STORAGE_KEY);

            if (privateJwkStr && publicJwkStr) {
                const privateJwk = JSON.parse(privateJwkStr);
                const publicJwk = JSON.parse(publicJwkStr);

                this.privateKey = await window.crypto.subtle.importKey(
                    "jwk",
                    privateJwk,
                    { name: "ECDH", namedCurve: "P-256" },
                    true, // Needs to be true for deriveKey/Bits
                    ["deriveKey", "deriveBits"]
                );

                this.publicKey = await window.crypto.subtle.importKey(
                    "jwk",
                    publicJwk,
                    { name: "ECDH", namedCurve: "P-256" },
                    true, // Needs to be true for deriveKey/Bits
                    [] // Public key usage
                );
            }
        } catch (error) {
            console.error("Error loading keys:", error);
            // Clear potentially corrupted keys
            localStorage.removeItem(E2EE_KEY_STORAGE_KEY);
            localStorage.removeItem(PUBLIC_KEY_STORAGE_KEY);
            this.privateKey = null;
            this.publicKey = null;
        }
    }

     async loadPairedKeys(): Promise<void> {
        console.log("Loading paired encryption keys...");
        this.pairedKeys.clear();
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(PAIRED_KEYS_STORAGE_KEY_PREFIX)) {
                const peerKeyString = key.substring(PAIRED_KEYS_STORAGE_KEY_PREFIX.length);
                const aesJwkStr = localStorage.getItem(key);
                if (aesJwkStr) {
                    try {
                        const aesJwk = JSON.parse(aesJwkStr);
                        const aesKey = await window.crypto.subtle.importKey(
                            "jwk",
                            aesJwk,
                            { name: "AES-GCM" },
                            true, // exportable? maybe not needed
                            ["encrypt", "decrypt"]
                        );
                        this.pairedKeys.set(peerKeyString, aesKey);
                        console.log(`Loaded paired key for peer: ${peerKeyString.substring(0,10)}...`);
                    } catch (error) {
                        console.error(`Error loading paired key for ${peerKeyString}:`, error);
                        // Remove corrupted key
                        localStorage.removeItem(key);
                    }
                }
            }
        }
    }


    getPublicKey(): CryptoKey | null {
        return this.publicKey;
    }

    // Add getter for private key needed by PairingService
    getPrivateKey(): CryptoKey | null {
        return this.privateKey;
    }

    async getPublicKeyString(): Promise<string | null> {
        if (!this.publicKey) return null;
        try {
            // Export as SPKI (SubjectPublicKeyInfo) format, then Base64 encode
            const spkiBuffer = await window.crypto.subtle.exportKey("spki", this.publicKey);
            return arrayBufferToBase64(spkiBuffer); // Use the utility function
        } catch (error) {
            console.error("Error exporting public key:", error);
            return null;
        }
    }

    // --- Pairing & Shared Keys ---

    async deriveAndStoreEncryptionKey(peerPublicKeyString: string, peerPublicKey: CryptoKey): Promise<CryptoKey | null> {
        if (!this.privateKey) {
            console.error("Private key not available for key derivation.");
            return null;
        }
        try {
            // Derive shared secret bits
            const sharedSecretBits = await window.crypto.subtle.deriveBits(
                { name: "ECDH", public: peerPublicKey },
                this.privateKey,
                256 // Derive 256 bits
            );

            // Use HKDF to derive a 256-bit AES key from the shared secret
            // (Using SubtleCrypto's deriveKey with HKDF requires importing the secret bits as a key first)
            const secretImportKey = await window.crypto.subtle.importKey(
                "raw",
                sharedSecretBits,
                { name: "HKDF" },
                false,
                ["deriveKey"]
            );

            const aesKey = await window.crypto.subtle.deriveKey(
                {
                    name: "HKDF",
                    salt: new Uint8Array(), // No salt, or use a fixed one? Consider implications.
                    info: new TextEncoder().encode("AES-GCM encryption key"), // Context info
                    hash: "SHA-256",
                },
                secretImportKey,
                { name: "AES-GCM", length: 256 }, // Derive AES-GCM key
                true, // Exportable to store it
                ["encrypt", "decrypt"]
            );

            // Store the derived AES key in memory and localStorage
            this.pairedKeys.set(peerPublicKeyString, aesKey);
            const aesJwk = await window.crypto.subtle.exportKey("jwk", aesKey);
            localStorage.setItem(PAIRED_KEYS_STORAGE_KEY_PREFIX + peerPublicKeyString, JSON.stringify(aesJwk));
            console.log(`Derived and stored encryption key for peer: ${peerPublicKeyString.substring(0,10)}...`);
            return aesKey;

        } catch (error) {
            console.error("Error deriving/storing encryption key:", error);
            return null;
        }
    }

    getEncryptionKey(peerPublicKeyString: string): CryptoKey | null {
        // Should already be loaded into map by init/deriveAndStore
        return this.pairedKeys.get(peerPublicKeyString) || null;
    }

    // --- Encryption/Decryption ---

    async encrypt(
        peerPublicKeyString: string,
        payload: unknown
    ): Promise<{ ciphertext: ArrayBuffer; nonce: Uint8Array } | null> {
        const key = this.getEncryptionKey(peerPublicKeyString);
        if (!key) {
            console.error("No encryption key found for peer:", peerPublicKeyString);
            return null;
        }
        try {
            const serializedPayload = JSON.stringify(payload);
            const encodedPayload = new TextEncoder().encode(serializedPayload);
            const nonce = window.crypto.getRandomValues(new Uint8Array(12)); // 12 bytes for AES-GCM

            const ciphertext = await window.crypto.subtle.encrypt(
                { name: "AES-GCM", iv: nonce },
                key,
                encodedPayload
            );

            return { ciphertext, nonce };
        } catch (error) {
            console.error("Encryption error:", error);
            return null;
        }
    }

    async decrypt(
        peerPublicKeyString: string,
        encryptedData: { ciphertext: ArrayBuffer; nonce: Uint8Array }
    ): Promise<unknown | null> {
        const key = this.getEncryptionKey(peerPublicKeyString);
        if (!key) {
            console.error("No decryption key found for peer:", peerPublicKeyString);
            return null;
        }
        try {
            const decryptedBuffer = await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: encryptedData.nonce },
                key,
                encryptedData.ciphertext
            );

            const decryptedString = new TextDecoder().decode(decryptedBuffer);
            return JSON.parse(decryptedString);
        } catch (error) {
            console.error("Decryption error:", error);
            // Could be wrong key, tampered data, or wrong nonce
            return null;
        }
    }

    // --- Utility ---
    async importPublicKey(keyString: string): Promise<CryptoKey | null> {
        try {
            // Assuming keyString is Base64 encoded SPKI
            const spkiBuffer = base64ToArrayBuffer(keyString); // Use the utility function

            // The comment block and the erroneous code below it are removed.
            // The correct importKey call remains.
            return await window.crypto.subtle.importKey(
                "spki",
                spkiBuffer, // Use the buffer from the utility function
                { name: "ECDH", namedCurve: "P-256" },
                true, // Needs to be true for deriveKey/Bits
                [] // Public key usage
            );
        } catch (error) {
            console.error("Error importing public key:", error);
            return null;
        }
    }
}