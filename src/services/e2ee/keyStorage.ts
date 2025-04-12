import * as vscode from 'vscode'; // <<< Add this import
import {
    initializeSodium,
    generateKeyPair,
    bytesToHex,
    hexToBytes,
} from './crypto';
import { v4 as uuidv4 } from 'uuid';

// --- Constants for localStorage keys ---
const LS_DEVICE_ID_KEY = 'e2ee_device_id';
const LS_PRIVATE_KEY_KEY = 'e2ee_private_key_hex';
const LS_PUBLIC_KEY_KEY = 'e2ee_public_key_hex'; // Own public key, for convenience
const LS_PEER_PUBLIC_KEY_PREFIX = 'e2ee_peer_public_key_'; // Prefix + peer identifier

export interface E2EEKeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}

/**
 * Interface for managing E2EE cryptographic keys and device identifiers.
 * Abstracts the underlying storage mechanism (SecretStorage, localStorage).
 */
export interface IE2EEKeyStorage {
    /**
     * Retrieves the client's own persistent key pair.
     * Generates and saves a new one if it doesn't exist.
     * @returns {Promise<E2EEKeyPair>} The key pair.
     */
    getOwnKeyPair(): Promise<E2EEKeyPair>;

    /**
     * Retrieves the public key of a previously paired peer.
     * @param peerId Identifier for the peer (e.g., extension instance ID).
     * @returns {Promise<Uint8Array | null>} The peer's public key or null if not found.
     */
    getPeerPublicKey(peerId: string): Promise<Uint8Array | null>;

    /**
     * Saves the public key of a successfully paired peer.
     * @param peerId Identifier for the peer.
     * @param publicKey The peer's public key.
     * @returns {Promise<void>}
     */
    savePeerPublicKey(peerId: string, publicKey: Uint8Array): Promise<void>;

    /**
     * Deletes the stored public key of a peer (e.g., if pairing is reset).
     * @param peerId Identifier for the peer.
     * @returns {Promise<void>}
     */
    deletePeerPublicKey(peerId: string): Promise<void>;

    /**
     * Retrieves the unique persistent identifier for this client instance.
     * Generates and saves a new one if it doesn't exist.
     * @returns {Promise<string>} The device ID.
     */
    getDeviceId(): Promise<string>;
}

// ============================================================================
// Web UI Implementation (using localStorage)
// ============================================================================

export class WebUIKeyStorage implements IE2EEKeyStorage {
    private ownKeyPair: E2EEKeyPair | null = null;
    private deviceId: string | null = null;

    async getOwnKeyPair(): Promise<E2EEKeyPair> {
        if (this.ownKeyPair) {
            return this.ownKeyPair;
        }

        await initializeSodium(); // Ensure crypto is ready

        const privateKeyHex = localStorage.getItem(LS_PRIVATE_KEY_KEY);
        const publicKeyHex = localStorage.getItem(LS_PUBLIC_KEY_KEY); // Also store public key for quick retrieval

        if (privateKeyHex && publicKeyHex) {
            try {
                const privateKey = hexToBytes(privateKeyHex);
                const publicKey = hexToBytes(publicKeyHex);
                // Optional: Verify the public key matches the private key
                // const sodium = getSodium();
                // const derivedPublicKey = sodium.crypto_scalarmult_base(privateKey);
                // if (sodium.compare(publicKey, derivedPublicKey) !== 0) {
                //     console.warn("Stored public key does not match derived public key. Regenerating.");
                //     return this.generateAndSaveNewKeyPair();
                // }
                this.ownKeyPair = { publicKey, privateKey };
                return this.ownKeyPair;
            } catch (error) {
                console.error("Failed to load keys from localStorage, generating new ones.", error);
                // Clear potentially corrupted keys
                localStorage.removeItem(LS_PRIVATE_KEY_KEY);
                localStorage.removeItem(LS_PUBLIC_KEY_KEY);
                return this.generateAndSaveNewKeyPair();
            }
        } else {
            // Keys not found, generate new ones
            return this.generateAndSaveNewKeyPair();
        }
    }

    private async generateAndSaveNewKeyPair(): Promise<E2EEKeyPair> {
        const keyPair = await generateKeyPair();
        localStorage.setItem(LS_PRIVATE_KEY_KEY, bytesToHex(keyPair.privateKey));
        localStorage.setItem(LS_PUBLIC_KEY_KEY, bytesToHex(keyPair.publicKey));
        this.ownKeyPair = keyPair;
        console.log("Generated and saved new E2EE key pair for Web UI.");
        return keyPair;
    }

    async getPeerPublicKey(peerId: string): Promise<Uint8Array | null> {
        await initializeSodium(); // Ensure crypto is ready for hexToBytes
        const keyHex = localStorage.getItem(LS_PEER_PUBLIC_KEY_PREFIX + peerId);
        if (!keyHex) {
            return null;
        }
        try {
            return hexToBytes(keyHex);
        } catch (error) {
            console.error(`Failed to parse stored peer public key for ${peerId}`, error);
            // Clean up potentially corrupted key
            localStorage.removeItem(LS_PEER_PUBLIC_KEY_PREFIX + peerId);
            return null;
        }
    }

    async savePeerPublicKey(peerId: string, publicKey: Uint8Array): Promise<void> {
        await initializeSodium(); // Ensure crypto is ready for bytesToHex
        localStorage.setItem(LS_PEER_PUBLIC_KEY_PREFIX + peerId, bytesToHex(publicKey));
    }

    async deletePeerPublicKey(peerId: string): Promise<void> {
        localStorage.removeItem(LS_PEER_PUBLIC_KEY_PREFIX + peerId);
    }

    async getDeviceId(): Promise<string> {
        if (this.deviceId) {
            return this.deviceId;
        }
        let storedId = localStorage.getItem(LS_DEVICE_ID_KEY);
        if (!storedId) {
            storedId = uuidv4();
            localStorage.setItem(LS_DEVICE_ID_KEY, storedId);
            console.log("Generated and saved new device ID for Web UI:", storedId);
        }
        this.deviceId = storedId;
        return storedId;
    }
}

// ============================================================================
// Extension Implementation (using vscode.SecretStorage)
// ============================================================================

// --- Constants for SecretStorage keys ---
const SS_PRIVATE_KEY_KEY = 'e2ee_extension_private_key_hex';
const SS_PUBLIC_KEY_KEY = 'e2ee_extension_public_key_hex'; // Own public key
const SS_PEER_PUBLIC_KEY_PREFIX = 'e2ee_peer_public_key_'; // Prefix + web UI device ID
const SS_DEVICE_ID_KEY = 'e2ee_extension_instance_id'; // Unique ID for this extension instance

export class ExtensionKeyStorage implements IE2EEKeyStorage {
    private ownKeyPair: E2EEKeyPair | null = null;
    private deviceId: string | null = null;

    constructor(private context: vscode.ExtensionContext) {}

    async getOwnKeyPair(): Promise<E2EEKeyPair> {
        if (this.ownKeyPair) {
            return this.ownKeyPair;
        }

        await initializeSodium(); // Ensure crypto is ready

        const privateKeyHex = await this.context.secrets.get(SS_PRIVATE_KEY_KEY);
        const publicKeyHex = await this.context.secrets.get(SS_PUBLIC_KEY_KEY);

        if (privateKeyHex && publicKeyHex) {
            try {
                const privateKey = hexToBytes(privateKeyHex);
                const publicKey = hexToBytes(publicKeyHex);
                // Optional: Verification could be added here as in WebUIKeyStorage
                this.ownKeyPair = { publicKey, privateKey };
                return this.ownKeyPair;
            } catch (error) {
                console.error("Failed to load keys from SecretStorage, generating new ones.", error);
                await this.context.secrets.delete(SS_PRIVATE_KEY_KEY);
                await this.context.secrets.delete(SS_PUBLIC_KEY_KEY);
                return this.generateAndSaveNewKeyPair();
            }
        } else {
            return this.generateAndSaveNewKeyPair();
        }
    }

    private async generateAndSaveNewKeyPair(): Promise<E2EEKeyPair> {
        const keyPair = await generateKeyPair();
        await this.context.secrets.store(SS_PRIVATE_KEY_KEY, bytesToHex(keyPair.privateKey));
        await this.context.secrets.store(SS_PUBLIC_KEY_KEY, bytesToHex(keyPair.publicKey));
        this.ownKeyPair = keyPair;
        console.log("Generated and saved new E2EE key pair for Extension.");
        return keyPair;
    }

    async getPeerPublicKey(peerId: string): Promise<Uint8Array | null> {
        await initializeSodium(); // Ensure crypto is ready for hexToBytes
        const keyHex = await this.context.secrets.get(SS_PEER_PUBLIC_KEY_PREFIX + peerId);
        if (!keyHex) {
            return null;
        }
        try {
            return hexToBytes(keyHex);
        } catch (error) {
            console.error(`Failed to parse stored peer public key for ${peerId}`, error);
            await this.context.secrets.delete(SS_PEER_PUBLIC_KEY_PREFIX + peerId);
            return null;
        }
    }

    async savePeerPublicKey(peerId: string, publicKey: Uint8Array): Promise<void> {
        await initializeSodium(); // Ensure crypto is ready for bytesToHex
        await this.context.secrets.store(SS_PEER_PUBLIC_KEY_PREFIX + peerId, bytesToHex(publicKey));
    }

    async deletePeerPublicKey(peerId: string): Promise<void> {
        await this.context.secrets.delete(SS_PEER_PUBLIC_KEY_PREFIX + peerId);
    }

    // Note: The concept of a "device ID" for the extension itself is less critical
    // than for the web UI, but we provide one for potential future use or consistency.
    async getDeviceId(): Promise<string> {
        if (this.deviceId) {
            return this.deviceId;
        }
        let storedId = await this.context.secrets.get(SS_DEVICE_ID_KEY);
        if (!storedId) {
            storedId = uuidv4();
            await this.context.secrets.store(SS_DEVICE_ID_KEY, storedId);
            console.log("Generated and saved new instance ID for Extension:", storedId);
        }
        this.deviceId = storedId;
        return storedId;
    }
}