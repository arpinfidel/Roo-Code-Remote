// src/services/e2ee/encryption.ts
import * as vscode from "vscode";
import { webcrypto as crypto } from "node:crypto"; // Use Node's SubtleCrypto
import { arrayBufferToBase64, base64ToArrayBuffer } from "../../utils/base64";

const E2EE_PRIVATE_KEY_STORAGE_KEY = "e2ee.privateKeyJwk"; // Store JWK string
const E2EE_PUBLIC_KEY_STORAGE_KEY = "e2ee.publicKeyJwk"; // Store JWK string
const PAIRED_KEYS_STORAGE_KEY_PREFIX = "e2ee.pairedKey."; // Prefix + peerPublicKeyString -> Stores AES JWK string
const PAIRED_PEERS_INDEX_KEY = "e2ee.pairedPeersIndex"; // Global state key for list of paired peer pub keys

// Cryptographic functions using Node's SubtleCrypto

export class EncryptionService {
    private privateKey: CryptoKey | null = null;
    private publicKey: CryptoKey | null = null;
    private pairedKeys: Map<string, CryptoKey> = new Map(); // Map<peerPublicKeyString, AESKey>

    constructor(private context: vscode.ExtensionContext) {}

    async init(): Promise<void> {
        console.log("Initializing Extension EncryptionService...");
        await this.loadKeys();
        if (!this.privateKey || !this.publicKey) {
            console.log("No keys found or loading failed, generating new ones...");
            await this.generateAndStoreKeys();
        } else {
             console.log("E2EE keys loaded successfully.");
        }
        await this.loadPairedKeys(); // Load keys for known peers
    }

    // --- Key Management ---

    async generateAndStoreKeys(): Promise<boolean> {
        console.log("Generating new E2EE key pair...");
        try {
            const keyPair = await crypto.subtle.generateKey(
                { name: "ECDH", namedCurve: "P-256" },
                true, // Exportable
                ["deriveKey", "deriveBits"]
            );

            this.privateKey = keyPair.privateKey;
            this.publicKey = keyPair.publicKey;

            // Store keys as JWK strings
            const privateJwk = await crypto.subtle.exportKey("jwk", this.privateKey);
            const publicJwk = await crypto.subtle.exportKey("jwk", this.publicKey);

            // Store private key securely
            await this.context.secrets.store(E2EE_PRIVATE_KEY_STORAGE_KEY, JSON.stringify(privateJwk));
            // Store public key normally (it's public)
            await this.context.globalState.update(E2EE_PUBLIC_KEY_STORAGE_KEY, JSON.stringify(publicJwk));

            console.log("New E2EE key pair generated and stored.");
            return true;
        } catch (error) {
            console.error("Error generating/storing keys:", error);
            // Clear any partial keys
            await this.context.secrets.delete(E2EE_PRIVATE_KEY_STORAGE_KEY);
            await this.context.globalState.update(E2EE_PUBLIC_KEY_STORAGE_KEY, undefined);
            this.privateKey = null;
            this.publicKey = null;
            return false;
        }
    }

    async loadKeys(): Promise<boolean> {
        console.log("Loading E2EE keys...");
        try {
            const privateJwkStr = await this.context.secrets.get(E2EE_PRIVATE_KEY_STORAGE_KEY);
            const publicJwkStr = await this.context.globalState.get<string>(E2EE_PUBLIC_KEY_STORAGE_KEY);

            if (privateJwkStr && publicJwkStr) {
                const privateJwk = JSON.parse(privateJwkStr);
                const publicJwk = JSON.parse(publicJwkStr);

                this.privateKey = await crypto.subtle.importKey(
                    "jwk",
                    privateJwk,
                    { name: "ECDH", namedCurve: "P-256" },
                    true, // Needs to be true for deriveKey/Bits
                    ["deriveKey", "deriveBits"]
                );

                this.publicKey = await crypto.subtle.importKey(
                    "jwk",
                    publicJwk,
                    { name: "ECDH", namedCurve: "P-256" },
                    true,
                    [] // Public key usage
                );
                 return true;
            }
             console.log("No stored E2EE keys found.");
             return false;
        } catch (error) {
            console.error("Error loading keys:", error);
            // Clear potentially corrupted keys
            await this.context.secrets.delete(E2EE_PRIVATE_KEY_STORAGE_KEY);
            await this.context.globalState.update(E2EE_PUBLIC_KEY_STORAGE_KEY, undefined);
            this.privateKey = null;
            this.publicKey = null;
            return false;
        }
    }

     async loadPairedKeys(): Promise<void> {
        console.log("Loading paired encryption keys...");
        this.pairedKeys.clear();
        const pairedPeers = this.context.globalState.get<string[]>(PAIRED_PEERS_INDEX_KEY, []);

        for (const peerKeyString of pairedPeers) {
            const storageKey = PAIRED_KEYS_STORAGE_KEY_PREFIX + peerKeyString;
            const aesJwkStr = await this.context.secrets.get(storageKey);
            if (aesJwkStr) {
                try {
                    const aesJwk = JSON.parse(aesJwkStr);
                    const aesKey = await crypto.subtle.importKey(
                        "jwk",
                        aesJwk,
                        { name: "AES-GCM" },
                        true,
                        ["encrypt", "decrypt"]
                    );
                    this.pairedKeys.set(peerKeyString, aesKey);
                    console.log(`Loaded paired key for peer: ${peerKeyString.substring(0,10)}...`);
                } catch (error) {
                    console.error(`Error loading paired key for ${peerKeyString}:`, error);
                    // Remove corrupted key and index entry
                    await this.context.secrets.delete(storageKey);
                    const updatedPeers = pairedPeers.filter(p => p !== peerKeyString);
                    await this.context.globalState.update(PAIRED_PEERS_INDEX_KEY, updatedPeers);
                }
            } else {
                 console.warn(`Paired key for ${peerKeyString} not found in storage, removing from index.`);
                 const updatedPeers = pairedPeers.filter(p => p !== peerKeyString);
                 await this.context.globalState.update(PAIRED_PEERS_INDEX_KEY, updatedPeers);
            }
        }
    }

    getPublicKey(): CryptoKey | null {
        return this.publicKey;
    }

    async getPublicKeyString(): Promise<string | null> {
        if (!this.publicKey) {
             console.warn("Public key not loaded or generated yet.");
             return null;
        }
        try {
            // Export as SPKI (SubjectPublicKeyInfo) format, then Base64 encode
            const spkiBuffer = await crypto.subtle.exportKey("spki", this.publicKey);
            return arrayBufferToBase64(spkiBuffer);
        } catch (error) {
            console.error("Error exporting public key:", error);
            return null;
        }
    }

     // Add getter for private key needed by PairingService
    getPrivateKey(): CryptoKey | null {
        return this.privateKey;
    }

    // --- Pairing & Shared Keys ---

    async deriveAndStoreEncryptionKey(peerPublicKeyString: string, peerPublicKey: CryptoKey): Promise<CryptoKey | null> {
        if (!this.privateKey) {
            console.error("Private key not available for key derivation.");
            return null;
        }
        try {
            // Derive shared secret bits
            const sharedSecretBits = await crypto.subtle.deriveBits(
                { name: "ECDH", public: peerPublicKey },
                this.privateKey,
                256 // Derive 256 bits
            );

            // Use HKDF to derive a 256-bit AES key from the shared secret
            const secretImportKey = await crypto.subtle.importKey(
                "raw",
                sharedSecretBits,
                { name: "HKDF" },
                false,
                ["deriveKey"]
            );

            const aesKey = await crypto.subtle.deriveKey(
                {
                    name: "HKDF",
                    salt: new Uint8Array(), // No salt for simplicity here
                    info: new TextEncoder().encode("AES-GCM encryption key"), // Context info
                    hash: "SHA-256",
                },
                secretImportKey,
                { name: "AES-GCM", length: 256 }, // Derive AES-GCM key
                true, // Exportable to store it
                ["encrypt", "decrypt"]
            );

            // Store the derived AES key in memory and SecretStorage
            this.pairedKeys.set(peerPublicKeyString, aesKey);
            const aesJwk = await crypto.subtle.exportKey("jwk", aesKey);
            const storageKey = PAIRED_KEYS_STORAGE_KEY_PREFIX + peerPublicKeyString;
            await this.context.secrets.store(storageKey, JSON.stringify(aesJwk));

            // Add peer to index if not already there
            const pairedPeers = this.context.globalState.get<string[]>(PAIRED_PEERS_INDEX_KEY, []);
            if (!pairedPeers.includes(peerPublicKeyString)) {
                await this.context.globalState.update(PAIRED_PEERS_INDEX_KEY, [...pairedPeers, peerPublicKeyString]);
            }

            console.log(`Derived and stored encryption key for peer: ${peerPublicKeyString.substring(0,10)}...`);
            return aesKey;

        } catch (error) {
            console.error("Error deriving/storing encryption key:", error);
            return null;
        }
    }

    // Key should be loaded into map by init or deriveAndStoreEncryptionKey
    getEncryptionKey(peerPublicKeyString: string): CryptoKey | null {
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
            // Use Node's crypto.randomBytes for nonce generation for better entropy if needed,
            // but webcrypto version is generally sufficient and cross-platform compatible.
            const nonce = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes for AES-GCM

            const ciphertext = await crypto.subtle.encrypt(
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
            const decryptedBuffer = await crypto.subtle.decrypt(
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
            const spkiBuffer = base64ToArrayBuffer(keyString);

            return await crypto.subtle.importKey(
                "spki",
                spkiBuffer,
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