import sodium, { KeyPair, StringOutputFormat, base64_variants } from "libsodium-wrappers"

// Ensure libsodium is ready before using it
let sodiumReadyPromise: Promise<void> | null = null

export async function initializeSodium(): Promise<void> {
	if (!sodiumReadyPromise) {
		sodiumReadyPromise = sodium.ready
	}
	await sodiumReadyPromise
	console.log("libsodium initialized successfully (Webview).")
}

/**
 * Generates a new X25519 key pair for Diffie-Hellman key exchange.
 * Keys are returned in Base64 format.
 */
export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
	await initializeSodium()
	const keyPair: KeyPair = sodium.crypto_kx_keypair()
	return {
		publicKey: sodium.to_base64(keyPair.publicKey, base64_variants.ORIGINAL),
		privateKey: sodium.to_base64(keyPair.privateKey, base64_variants.ORIGINAL),
	}
}

/**
 * Calculates the shared secret using Diffie-Hellman (X25519).
 * Assumes keys are in Base64 format. Returns the shared secret in Base64.
 * Needs separate client/server versions due to libsodium API structure.
 * Webview acts as the 'client' in the key exchange with the extension ('server').
 */
export async function calculateClientSharedSecret(
	clientPrivateKeyBase64: string,
	clientPublicKeyBase64: string, // Included for consistency
	serverPublicKeyBase64: string,
): Promise<string> {
	await initializeSodium()
	const clientSk = sodium.from_base64(clientPrivateKeyBase64, base64_variants.ORIGINAL)
	const clientPk = sodium.from_base64(clientPublicKeyBase64, base64_variants.ORIGINAL)
	const serverPk = sodium.from_base64(serverPublicKeyBase64, base64_variants.ORIGINAL)
	const sharedSecret = sodium.crypto_kx_client_session_keys(clientPk, clientSk, serverPk)
	// Using sharedTx for encryption based on libsodium examples
	return sodium.to_base64(sharedSecret.sharedTx, base64_variants.ORIGINAL)
}

// Note: The webview won't typically act as the 'server' in the key exchange with the extension.
// The calculateServerSharedSecret function might not be needed here, but kept for symmetry for now.
export async function calculateServerSharedSecret(
	serverPrivateKeyBase64: string,
	serverPublicKeyBase64: string, // Included for consistency
	clientPublicKeyBase64: string,
): Promise<string> {
	await initializeSodium()
	const serverSk = sodium.from_base64(serverPrivateKeyBase64, base64_variants.ORIGINAL)
	const serverPk = sodium.from_base64(serverPublicKeyBase64, base64_variants.ORIGINAL)
	const clientPk = sodium.from_base64(clientPublicKeyBase64, base64_variants.ORIGINAL)
	const sharedSecret = sodium.crypto_kx_server_session_keys(serverPk, serverSk, clientPk)
	// Using sharedRx for encryption based on libsodium examples
	return sodium.to_base64(sharedSecret.sharedRx, base64_variants.ORIGINAL)
}

/**
 * Encrypts a message using ChaCha20-Poly1305 (crypto_aead_chacha20poly1305_ietf_encrypt).
 * @param message The plaintext message (string).
 * @param sharedSecretBase64 The shared secret key (Base64).
 * @returns The ciphertext including the nonce (Base64).
 */
export async function encryptMessage(message: string, sharedSecretBase64: string): Promise<string> {
	await initializeSodium()
	const key = sodium.from_base64(sharedSecretBase64, base64_variants.ORIGINAL)
	const nonce = sodium.randombytes_buf(sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES)
	const messageBytes = sodium.from_string(message)

	const ciphertext = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
		messageBytes,
		null, // No additional authenticated data
		null, // nsec - must be null according to docs
		nonce,
		key,
	)

	// Prepend nonce to ciphertext for decryption
	const nonceAndCiphertext = new Uint8Array(nonce.length + ciphertext.length)
	nonceAndCiphertext.set(nonce)
	nonceAndCiphertext.set(ciphertext, nonce.length)

	return sodium.to_base64(nonceAndCiphertext, base64_variants.ORIGINAL)
}

/**
 * Decrypts a message using ChaCha20-Poly1305 (crypto_aead_chacha20poly1305_ietf_decrypt).
 * @param encryptedMessageBase64 The ciphertext including the prepended nonce (Base64).
 * @param sharedSecretBase64 The shared secret key (Base64).
 * @returns The original plaintext message (string).
 */
export async function decryptMessage(encryptedMessageBase64: string, sharedSecretBase64: string): Promise<string> {
	await initializeSodium()
	const key = sodium.from_base64(sharedSecretBase64, base64_variants.ORIGINAL)
	const nonceAndCiphertext = sodium.from_base64(encryptedMessageBase64, base64_variants.ORIGINAL)

	if (nonceAndCiphertext.length < sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES) {
		throw new Error("Encrypted message is too short to contain a nonce.")
	}

	const nonce = nonceAndCiphertext.slice(0, sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES)
	const ciphertext = nonceAndCiphertext.slice(sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES)

	const decryptedBytes = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
		null, // nsec - must be null
		ciphertext,
		null, // No additional authenticated data
		nonce,
		key,
	)

	return sodium.to_string(decryptedBytes)
}

/**
 * Calculates a verification value for pairing using crypto_generichash (BLAKE2b).
 * This combines keys and the code to ensure both parties agree.
 * @param publicKey1Base64 Public key of party 1 (Base64).
 * @param publicKey2Base64 Public key of party 2 (Base64).
 * @param pairingCode The shared pairing code (string).
 * @returns A verification hash (Base64).
 */
export async function calculateVerificationValue(
	publicKey1Base64: string,
	publicKey2Base64: string,
	pairingCode: string,
): Promise<string> {
	await initializeSodium()
	// Sort keys lexicographically to ensure consistent input order
	const keys = [publicKey1Base64, publicKey2Base64].sort()
	const inputString = `${keys[0]}:${keys[1]}:${pairingCode}`
	const inputBytes = sodium.from_string(inputString)

	// Using default crypto_generichash (BLAKE2b)
	const hash = sodium.crypto_generichash(sodium.crypto_generichash_BYTES, inputBytes)
	return sodium.to_base64(hash, base64_variants.ORIGINAL)
}

// Helper to convert Base64 string to Uint8Array
export function base64ToUint8Array(base64String: string): Uint8Array {
	return sodium.from_base64(base64String, base64_variants.ORIGINAL)
}

// Helper to convert Uint8Array to Base64 string
export function uint8ArrayToBase64(arr: Uint8Array): string {
	return sodium.to_base64(arr, base64_variants.ORIGINAL)
}