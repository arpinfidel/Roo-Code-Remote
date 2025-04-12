import * as vscode from "vscode"
import sodium from "libsodium-wrappers"

// Constants for SecretStorage keys
const E2EE_PRIVATE_KEY_KEY = "roo.e2ee.privateKey"
const E2EE_PEER_PUBLIC_KEY_KEY_PREFIX = "roo.e2ee.peerPublicKey."
const E2EE_SHARED_SECRET_KEY_PREFIX = "roo.e2ee.sharedSecret."

export interface KeyPair { // Added export
	publicKey: Uint8Array
	privateKey: Uint8Array
}

export interface EncryptedPayload { // Added export
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
 * Stores the private key securely using VS Code SecretStorage.
 */
async function storePrivateKey(context: vscode.ExtensionContext, privateKey: Uint8Array): Promise<void> {
	const privateKeyBase64 = sodium.to_base64(privateKey, sodium.base64_variants.ORIGINAL)
	await context.secrets.store(E2EE_PRIVATE_KEY_KEY, privateKeyBase64)
}

/**
 * Retrieves the private key from VS Code SecretStorage.
 */
async function getPrivateKey(context: vscode.ExtensionContext): Promise<Uint8Array | null> {
	const privateKeyBase64 = await context.secrets.get(E2EE_PRIVATE_KEY_KEY)
	if (!privateKeyBase64) {
		return null
	}
	return sodium.from_base64(privateKeyBase64, sodium.base64_variants.ORIGINAL)
}

/**
 * Gets the existing key pair or generates a new one if none exists.
 */
export async function getOrCreateKeyPair(context: vscode.ExtensionContext): Promise<KeyPair> {
	await ensureSodiumReady()
	let privateKey = await getPrivateKey(context)
	if (privateKey) {
		// Derive public key from private key
		const publicKey = sodium.crypto_scalarmult_base(privateKey)
		return { publicKey, privateKey }
	} else {
		// Generate new key pair and store it
		const newKeyPair = await generateKeyPair()
		await storePrivateKey(context, newKeyPair.privateKey)
		console.log("Generated and stored new E2EE key pair.")
		return newKeyPair
	}
}

/**
 * Stores the peer's public key associated with a peer ID.
 */
export async function storePeerPublicKey(
	context: vscode.ExtensionContext,
	peerId: string,
	publicKey: Uint8Array,
): Promise<void> {
	const key = `${E2EE_PEER_PUBLIC_KEY_KEY_PREFIX}${peerId}`
	const publicKeyBase64 = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)
	await context.secrets.store(key, publicKeyBase64)
}

/**
 * Retrieves the peer's public key associated with a peer ID.
 */
export async function getPeerPublicKey(
	context: vscode.ExtensionContext,
	peerId: string,
): Promise<Uint8Array | null> {
	await ensureSodiumReady()
	const key = `${E2EE_PEER_PUBLIC_KEY_KEY_PREFIX}${peerId}`
	const publicKeyBase64 = await context.secrets.get(key)
	return publicKeyBase64 ? sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL) : null
}

/**
 * Stores the derived shared secret associated with a peer ID.
 */
export async function storeSharedSecret(
	context: vscode.ExtensionContext,
	peerId: string,
	sharedSecret: Uint8Array,
): Promise<void> {
	const key = `${E2EE_SHARED_SECRET_KEY_PREFIX}${peerId}`
	const secretBase64 = sodium.to_base64(sharedSecret, sodium.base64_variants.ORIGINAL)
	await context.secrets.store(key, secretBase64)
}

/**
 * Retrieves the shared secret associated with a peer ID.
 */
export async function getSharedSecret(
	context: vscode.ExtensionContext,
	peerId: string,
): Promise<Uint8Array | null> {
	await ensureSodiumReady()
	const key = `${E2EE_SHARED_SECRET_KEY_PREFIX}${peerId}`
	const secretBase64 = await context.secrets.get(key)
	return secretBase64 ? sodium.from_base64(secretBase64, sodium.base64_variants.ORIGINAL) : null
}

/**
 * Derives the shared secret using own key pair and peer's public key (Client side).
 * Requires the client's full key pair (public and private).
 */
export async function deriveSharedSecretClient(
	ownPublicKey: Uint8Array,
	ownPrivateKey: Uint8Array,
	peerPublicKey: Uint8Array,
): Promise<Uint8Array> {
	await ensureSodiumReady()
	// crypto_kx_client_session_keys computes two keys (rx, tx) for the client
	// rx: key for receiving data from the server
	// tx: key for sending data to the server
	// and 'rx' for decryption from server/peer to client.
	// For simplicity in this example, we might just use one derived key,
	// but using separate rx/tx keys is more robust.
	// We will use 'sharedTx' for encrypting messages sent *from* this client
	// and 'sharedRx' for decrypting messages received *by* this client.
	// For simplicity in this initial implementation, we might only use one,
	// but ideally, separate keys should be maintained. Let's return both for now.
	// TODO: Decide if we need separate Rx/Tx keys or can use one derived key.
	const { sharedRx, sharedTx } = sodium.crypto_kx_client_session_keys(
		ownPublicKey,
		ownPrivateKey,
		peerPublicKey,
	)
	// For now, let's return sharedTx as the primary key for encrypt/decrypt
	// This assumes the peer (WebUI) will do the same using its derived keys.
	return sharedTx
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
 * Generates a secure random pairing code (e.g., 6 digits).
 */
export async function generatePairingCode(length = 6): Promise<string> {
	await ensureSodiumReady()
	const digits = "0123456789"
	let code = ""
	for (let i = 0; i < length; i++) {
		code += digits[sodium.randombytes_uniform(digits.length)]
	}
	return code
}

/**
 * Computes a verification hash for the pairing process.
 * Uses Blake2b for hashing.
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