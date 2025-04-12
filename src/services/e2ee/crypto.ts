import * as vscode from 'vscode';
import sodium from 'libsodium-wrappers';

let _sodium: typeof sodium | null = null;

/**
 * Initializes the sodium library. Must be called before any other crypto function.
 * Handles potential multiple initializations gracefully.
 */
export async function initializeSodium(): Promise<typeof sodium> {
    if (_sodium) {
        return _sodium;
    }
    try {
        await sodium.ready;
        _sodium = sodium;
        console.log('libsodium-wrappers initialized successfully.');
        return _sodium;
    } catch (error) {
        console.error('Failed to initialize libsodium-wrappers:', error);
        throw new Error('libsodium-wrappers initialization failed');
    }
}

/**
 * Ensures sodium is initialized and returns the instance.
 * Throws an error if initialization hasn't completed.
 */
function getSodium(): typeof sodium {
    if (!_sodium) {
        // This should ideally not happen if initializeSodium is called correctly at startup
        console.error('Sodium accessed before initialization!');
        throw new Error('Cryptography library not initialized. Call initializeSodium first.');
    }
    return _sodium;
}

/**
 * Generates a new X25519 key pair for E2EE.
 * @returns {Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }>} The generated key pair.
 */
export async function generateKeyPair(): Promise<{ publicKey: Uint8Array, privateKey: Uint8Array }> {
    const sodium = await initializeSodium(); // Ensure initialized
    const keyPair = sodium.crypto_box_keypair();
    return keyPair;
}

/**
 * Converts a Uint8Array to a Hex string.
 * @param bytes The byte array.
 * @returns The hex string representation.
 */
export function bytesToHex(bytes: Uint8Array): string {
    const sodium = getSodium();
    return sodium.to_hex(bytes);
}

/**
 * Converts a Hex string to a Uint8Array.
 * @param hexString The hex string.
 * @returns The byte array.
 */
export function hexToBytes(hexString: string): Uint8Array {
    const sodium = getSodium();
    return sodium.from_hex(hexString);
}

/**
 * Computes the shared secret using ECDH (X25519).
 * @param myPrivateKey This client's private key.
 * @param peerPublicKey The other client's public key.
 * @returns {Uint8Array} The computed shared secret.
 */
export function computeSharedSecret(myPrivateKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
    const sodium = getSodium();
    // crypto_scalarmult computes the shared secret from one's private key and peer's public key
    return sodium.crypto_scalarmult(myPrivateKey, peerPublicKey);
}

/**
 * Derives symmetric keys from a shared secret using KDF.
 * We'll derive two keys: one for client->server encryption, one for server->client.
 * @param sharedSecret The result from computeSharedSecret.
 * @param keyLength The desired length for each key (e.g., sodium.crypto_aead_chacha20poly1305_ietf_KEYBYTES).
 * @param context A context string to ensure key separation (e.g., "E2EE_Derivation").
 * @returns {Promise<{ txKey: Uint8Array, rxKey: Uint8Array }>} The derived transmission (tx) and reception (rx) keys.
 */
export async function deriveKeys(sharedSecret: Uint8Array, keyLength: number, context: string): Promise<{ txKey: Uint8Array, rxKey: Uint8Array }> {
    const sodium = await initializeSodium(); // Ensure initialized for KDF constants
    // const contextBytes = sodium.from_string(context); // Context should be a string

    // Derive the transmission key (e.g., used by this client to send)
    const txKey = sodium.crypto_kdf_derive_from_key(
        keyLength,
        1, // Subkey ID 1 for tx
        context, // Pass the context string directly
        sharedSecret
    );

    // Derive the reception key (e.g., used by this client to receive)
    const rxKey = sodium.crypto_kdf_derive_from_key(
        keyLength,
        2, // Subkey ID 2 for rx
        context, // Pass the context string directly
        sharedSecret
    );

    return { txKey, rxKey };
}


/**
 * Generates a random nonce suitable for ChaCha20-Poly1305 AEAD.
 * @returns {Uint8Array} A nonce of the required length.
 */
export function generateNonce(): Uint8Array {
    const sodium = getSodium();
    return sodium.randombytes_buf(sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES);
}

/**
 * Encrypts a message using ChaCha20-Poly1305 AEAD.
 * @param message The plaintext message (Uint8Array).
 * @param key The symmetric encryption key.
 * @param nonce The nonce to use (must be unique per key/message).
 * @param additionalData Optional additional authenticated data (AAD).
 * @returns {Uint8Array} The ciphertext.
 */
export function encryptMessage(
    message: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    additionalData: Uint8Array | null = null
): Uint8Array {
    const sodium = getSodium();
    return sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
        message,
        additionalData,
        null, // nsec is not used in IETF variant
        nonce,
        key
    );
}

/**
 * Decrypts a message using ChaCha20-Poly1305 AEAD.
 * @param ciphertext The ciphertext (Uint8Array).
 * @param key The symmetric decryption key.
 * @param nonce The nonce used during encryption.
 * @param additionalData Optional additional authenticated data (AAD) used during encryption.
 * @returns {Uint8Array | null} The original plaintext message, or null if decryption fails (tag mismatch).
 */
export function decryptMessage(
    ciphertext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array,
    additionalData: Uint8Array | null = null
): Uint8Array | null {
    const sodium = getSodium();
    try {
        return sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
            null, // nsec is not used in IETF variant
            ciphertext,
            additionalData,
            nonce,
            key
        );
    } catch (error) {
        console.error("Decryption failed (likely tag mismatch):", error);
        return null; // Indicate decryption failure
    }
}

/**
 * Computes a generic hash (Blake2b) of the input data.
 * @param data The data to hash (Uint8Array).
 * @param key Optional key for keyed hashing (MAC).
 * @param outputLength The desired length of the hash output. Defaults to sodium.crypto_generichash_BYTES.
 * @returns {Uint8Array} The computed hash.
 */
export function hashData(
    data: Uint8Array,
    key: Uint8Array | null = null,
    outputLength: number = sodium.crypto_generichash_BYTES
): Uint8Array {
    const sodium = getSodium();
    return sodium.crypto_generichash(outputLength, data, key);
}