import sodium from "libsodium-wrappers"

// Constants for localStorage keys
const E2EE_PRIVATE_KEY_KEY = "roo.e2ee.privateKey"
const E2EE_PEER_PUBLIC_KEY_KEY_PREFIX = "roo.e2ee.peerPublicKey."
const E2EE_SHARED_SECRET_KEY_PREFIX = "roo.e2ee.sharedSecret."

export interface KeyPair { // Added export
	publicKey: Uint8Array
	privateKey: Uint8Array
}

export interface EncryptedPayload {
	ciphertext: string // base64 encoded
	nonce: string // base64 encoded
}

// Ensure libsodium is ready before use
let sodiumReadyPromise: Promise<void> | null = null
async function ensureSodiumReady() {
	if (!sodiumReadyPromise) {
		sodiumReadyPromise = sodium.ready
	}
	await sodiumReadyPromise
}

/**
 * Generates a new X25519 key pair for E2EE.
 */
async function generateKeyPair(): Promise<KeyPair> {
	await ensureSodiumReady()
	return sodium.crypto_kx_keypair()
}

/**
 * Stores the private key securely using localStorage.
 * Note: localStorage is not ideal for highly sensitive keys, but suitable for this use case.
 */
async function storePrivateKey(privateKey: Uint8Array): Promise<void> {
	await ensureSodiumReady()
	const privateKeyBase64 = sodium.to_base64(privateKey, sodium.base64_variants.ORIGINAL)
	localStorage.setItem(E2EE_PRIVATE_KEY_KEY, privateKeyBase64)
}

/**
 * Retrieves the private key from localStorage.
 */
async function getPrivateKey(): Promise<Uint8Array | null> {
	await ensureSodiumReady()
	const privateKeyBase64 = localStorage.getItem(E2EE_PRIVATE_KEY_KEY)
	if (!privateKeyBase64) {
		return null
	}
	try {
		return sodium.from_base64(privateKeyBase64, sodium.base64_variants.ORIGINAL)
	} catch (e) {
		console.error("Failed to parse private key from localStorage", e)
		localStorage.removeItem(E2EE_PRIVATE_KEY_KEY) // Clear invalid key
		return null
	}
}

/**
 * Gets the existing key pair or generates a new one if none exists.
 */
export async function getOrCreateKeyPair(): Promise<KeyPair> {
	await ensureSodiumReady()
	let privateKey = await getPrivateKey()
	if (privateKey) {
		// Derive public key from private key
		const publicKey = sodium.crypto_scalarmult_base(privateKey)
		return { publicKey, privateKey }
	} else {
		// Generate new key pair and store it
		const newKeyPair = await generateKeyPair()
		await storePrivateKey(newKeyPair.privateKey)
		console.log("Generated and stored new E2EE key pair for WebUI.")
		return newKeyPair
	}
}

/**
 * Stores the peer's public key associated with a peer ID in localStorage.
 */
export async function storePeerPublicKey(peerId: string, publicKey: Uint8Array): Promise<void> {
	await ensureSodiumReady()
	const key = `${E2EE_PEER_PUBLIC_KEY_KEY_PREFIX}${peerId}`
	const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)
	localStorage.setItem(key, publicKeyBase64)
}

/**
 * Retrieves the peer's public key associated with a peer ID from localStorage.
 */
export async function getPeerPublicKey(peerId: string): Promise<Uint8Array | null> {
	await ensureSodiumReady()
	const key = `${E2EE_PEER_PUBLIC_KEY_KEY_PREFIX}${peerId}`
	const publicKeyBase64 = localStorage.getItem(key)
	if (!publicKeyBase64) return null
	try {
		return sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL)
	} catch (e) {
		console.error("Failed to parse peer public key from localStorage", e)
		localStorage.removeItem(key) // Clear invalid key
		return null
	}
}

/**
 * Stores the derived shared secret associated with a peer ID in localStorage.
 */
export async function storeSharedSecret(peerId: string, sharedSecret: Uint8Array): Promise<void> {
	await ensureSodiumReady()
	const key = `${E2EE_SHARED_SECRET_KEY_PREFIX}${peerId}`
	const secretBase64 = sodium.to_base64(sharedSecret, sodium.base64_variants.ORIGINAL)
	localStorage.setItem(key, secretBase64)
}

/**
 * Retrieves the shared secret associated with a peer ID from localStorage.
 */
export async function getSharedSecret(peerId: string): Promise<Uint8Array | null> {
	await ensureSodiumReady()
	const key = `${E2EE_SHARED_SECRET_KEY_PREFIX}${peerId}`
	const secretBase64 = localStorage.getItem(key)
	if (!secretBase64) return null
	try {
		return sodium.from_base64(secretBase64, sodium.base64_variants.ORIGINAL)
	} catch (e) {
		console.error("Failed to parse shared secret from localStorage", e)
		localStorage.removeItem(key) // Clear invalid key
		return null
	}
}

/**
 * Derives the shared secret using own key pair and peer's public key (Server side perspective in KX).
 * The WebUI acts as the 'server' in the key exchange initiated by the extension ('client').
 */
export async function deriveSharedSecretServer(
	ownPublicKey: Uint8Array,
	ownPrivateKey: Uint8Array,
	peerPublicKey: Uint8Array,
): Promise<Uint8Array> {
	await ensureSodiumReady()
	// crypto_kx_server_session_keys computes two keys (rx, tx) for the server
	// rx: key for receiving data from the client
	// tx: key for sending data to the client
	const { sharedRx, sharedTx } = sodium.crypto_kx_server_session_keys(
		ownPublicKey,
		ownPrivateKey,
		peerPublicKey,
	)
	// For WebUI (server perspective):
	// - Use sharedRx to decrypt messages *from* the extension (client).
	// - Use sharedTx to encrypt messages *to* the extension (client).
	// For simplicity now, return sharedRx as the primary key for decrypt/encrypt.
	// This assumes the peer (Extension) uses its corresponding key (sharedTx from client perspective).
	// TODO: Decide if we need separate Rx/Tx keys or can use one derived key.
	return sharedRx
}

/**
 * Encrypts a payload using the shared secret.
 */
export async function encryptPayload(payload: unknown, sharedSecret: Uint8Array): Promise<EncryptedPayload> {
	await ensureSodiumReady()
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
	const messageString = JSON.stringify(payload)
	const messageBytes = sodium.from_string(messageString)

	const ciphertext = sodium.crypto_secretbox_easy(messageBytes, nonce, sharedSecret)

	return {
		ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
		nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
	}
}

/**
 * Decrypts an encrypted payload using the shared secret.
 */
export async function decryptPayload<T>(
	encryptedPayload: EncryptedPayload,
	sharedSecret: Uint8Array,
): Promise<T | null> {
	await ensureSodiumReady()
	try {
		const ciphertext = sodium.from_base64(encryptedPayload.ciphertext, sodium.base64_variants.ORIGINAL)
		const nonce = sodium.from_base64(encryptedPayload.nonce, sodium.base64_variants.ORIGINAL)

		const decryptedBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sharedSecret)
		const decryptedString = sodium.to_string(decryptedBytes)
		return JSON.parse(decryptedString) as T
	} catch (error) {
		console.error("E2EE Decryption failed:", error)
		// Handle potential errors (e.g., tampered message, wrong key)
		return null
	}
}

/**
 * Computes a verification hash for the pairing process.
 * Uses Blake2b for hashing. (Identical logic to extension side)
 */
export async function computeVerificationHash(
	publicKeyA: Uint8Array,
	publicKeyB: Uint8Array,
	pairingCode: string,
): Promise<string> {
	await ensureSodiumReady()
	const context = sodium.crypto_generichash_init(null, sodium.crypto_generichash_BYTES) // Use default hash size
	sodium.crypto_generichash_update(context, publicKeyA)
	sodium.crypto_generichash_update(context, publicKeyB)
	sodium.crypto_generichash_update(context, sodium.from_string(pairingCode))
	const hashBytes = sodium.crypto_generichash_final(context, sodium.crypto_generichash_BYTES)
	return sodium.to_base64(hashBytes, sodium.base64_variants.URLSAFE_NO_PADDING)
}