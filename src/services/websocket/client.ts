import { EventEmitter } from "events"
import WebSocket from "ws"
import { v4 as uuidv4 } from "uuid"
import * as vscode from "vscode"
// Use sodium directly for base64 conversion
import sodium from "libsodium-wrappers"

import {
	WebSocketConfig,
	WebSocketMessage,
	PairingAction,
	PairingStartPayload,
	PairingExchangePayload,
	PairingErrorPayload,
} from "./types"
import * as crypto from "./crypto"

// Define events emitted by this client
type WebSocketClientEvent =
	| "connecting"
	| "connected"
	| "disconnected"
	| "message" // Emits decrypted message
	| "error" // WebSocket or general errors
	| "e2ee_error" // Specific E2EE errors (encryption, decryption, pairing)
	| "pairing_status_changed" // Emits the new PairingState

type PairingState = "unpaired" | "pairing" | "paired" | "error"
type MessageHandler = (message: WebSocketMessage) => void
type ErrorHandler = (error: Error) => void

export class WebSocketClient extends EventEmitter {
	private socket: WebSocket | null = null
	private retryCount = 0
	private connectionState: "disconnected" | "connecting" | "connected" = "disconnected"
	private config: WebSocketConfig
	private context: vscode.ExtensionContext // Added context
	private messageQueue: Array<{
		message: WebSocketMessage
		resolve: () => void
		reject: (reason?: any) => void
	}> = []
	private url: URL = new URL("http://localhost")

	// E2EE State
	private keyPair: crypto.KeyPair | null = null
	private peerId: string | null = null // Identifier for the paired peer (e.g., webview session ID)
	private sharedSecret: Uint8Array | null = null
	private pairingState: PairingState = "unpaired"
	private currentPairingCode: string | null = null // Code generated during pairing attempt
	private pairingTimeout: NodeJS.Timeout | null = null // Timeout for pairing attempt

	constructor(config: WebSocketConfig, context: vscode.ExtensionContext) { // Added context
		super()
		this.config = config
		this.context = context // Store context
		this.url = new URL(config.serverUrl)
		this.initializeE2EE().catch((err) => {
			console.error("Failed to initialize E2EE:", err)
			this.pairingState = "error"
			this.emit("e2ee_error", err)
		})
	}

	private async initializeE2EE() {
			// Remove duplicate call
			this.keyPair = await crypto.getOrCreateKeyPair(this.context)
			console.log("E2EE Key Pair loaded/generated for Extension.")

		// Attempt to load existing pairing info (use sessionId as peerId for now)
		this.peerId = this.config.sessionId // Assuming peerId is the webview session ID
		if (this.peerId) {
			this.sharedSecret = await crypto.getSharedSecret(this.context, this.peerId)
			if (this.sharedSecret) {
				this.pairingState = "paired"
				console.log(`E2EE: Resumed paired state with peer ${this.peerId}`)
			} else {
				this.pairingState = "unpaired"
				console.log(`E2EE: No existing shared secret found for peer ${this.peerId}`)
			}
		} else {
			this.pairingState = "unpaired"
			console.warn("E2EE: Session ID not available on init, cannot load pairing info.")
		}
		this.emit("pairing_status_changed", this.pairingState)
	}

	public connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.connectionState === "connected") {
				return resolve()
			}
			this.url.searchParams.set("session_id", this.config.sessionId)
			this.url.searchParams.set("client_type", this.config.clientType)

			console.log("Attempting WebSocket connection to:", this.url)

			this.connectionState = "connecting"
			this.emit("connecting") // Emit connecting state

			// Get the Firebase ID token from the provider
			const firebaseIdToken = this.config.provider.getFirebaseIdToken()

			if (!firebaseIdToken) {
				const errorMsg = "Firebase ID token not available. Cannot establish WebSocket connection."
				console.error(errorMsg)
				this.emit("error", new Error(errorMsg))
				reject(new Error(errorMsg))
				return // Stop connection attempt
			}

			this.socket = new WebSocket(this.url, {
				headers: {
					Authorization: `Bearer ${firebaseIdToken}`, // Use Firebase token
				},
			})

			this.socket.on("open", () => {
				this.connectionState = "connected"
				this.retryCount = 0
				this.flushMessageQueue()
				this.emit("connected")
				resolve()
			})

			this.socket.on("message", (data: WebSocket.Data) => this.handleIncomingMessage(data))

			this.socket.on("close", () => {
				this.connectionState = "disconnected"
				console.log("WebSocket connection closed")
				this.emit("disconnected")
				this.handleReconnect()
			})

			this.socket.on("error", (err: Error) => {
				const wasConnecting = this.connectionState === "connecting"
				this.connectionState = "disconnected" // Treat error as disconnected
				console.error("WebSocket error:", err)
				this.emit("error", err) // Emit the specific error
				// If it failed while connecting, also emit disconnected to reset UI
				if (wasConnecting) {
					this.emit("disconnected")
				}
				reject(err)
			})
		})
	}

	private handleReconnect() {
		if (this.retryCount < this.config.maxRetries) {
			this.retryCount++
			console.log(`Attempting to reconnect (attempt ${this.retryCount}/${this.config.maxRetries})`)
			setTimeout(() => this.connect(), this.config.reconnectInterval)
		}
	}

	// --- Pairing Logic ---

	/**
	 * Initiates the pairing process with the WebUI.
	 * Generates a code, displays it, and sends the 'start' message.
	 */
	public async initiatePairing(): Promise<void> {
		if (!this.keyPair) {
			throw new Error("E2EE KeyPair not initialized.")
		}
		if (this.pairingState === "pairing") {
			console.warn("Pairing already in progress.")
			return
		}
		if (this.pairingState === "paired") {
			// TODO: Add option to re-pair or revoke existing pairing?
			console.warn("Already paired.")
			vscode.window.showInformationMessage("Already securely paired with the Web UI.")
			return
		}

		this.resetPairingState() // Clear any previous failed attempts
		this.pairingState = "pairing"
		this.emit("pairing_status_changed", this.pairingState)
		console.log("E2EE: Initiating pairing...")

		try {
			this.currentPairingCode = await crypto.generatePairingCode()

			// Display code to user (modal, timeout)
			const userResponse = await vscode.window.showInformationMessage(
				`Enter this code in the Roo Code Web UI to pair securely: ${this.currentPairingCode}`,
				{ modal: true }, // Keep message box open
				"Cancel",
			)

			if (userResponse === "Cancel" || this.pairingState !== "pairing") {
				console.log("E2EE: Pairing cancelled by user or state change.")
				this.resetPairingState()
				return
			}

			// Set timeout for the pairing attempt (e.g., 5 minutes)
			this.pairingTimeout = setTimeout(() => {
				if (this.pairingState === "pairing") {
					console.error("E2EE: Pairing timed out.")
					vscode.window.showErrorMessage("Pairing timed out. Please try again.")
					this.sendPairingError("timeout") // Inform peer if possible
					this.resetPairingState()
				}
			}, 5 * 60 * 1000) // 5 minutes

			// Send the start message
			await sodium.ready // Ensure sodium is ready before conversion
			const payload: PairingStartPayload = {
				extensionPublicKey: sodium.to_base64(this.keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
			}
			await this.sendPairingMessage("start", payload)
			console.log("E2EE: Pairing code displayed and 'start' message sent.")
		} catch (err) {
			console.error("E2EE: Error initiating pairing:", err)
			vscode.window.showErrorMessage(`Failed to start pairing: ${err instanceof Error ? err.message : err}`)
			this.resetPairingState()
			this.emit("e2ee_error", err)
		}
	}

	private async handlePairingMessage(message: WebSocketMessage) {
		if (!this.keyPair) {
			console.error("E2EE: Received pairing message but keypair is not initialized.")
			return
		}

		const action = message.action as PairingAction
		const payload = message.pairingPayload

		console.log(`E2EE: Received pairing message - Action: ${action}`)

		switch (action) {
			case "exchange":
				if (this.pairingState !== "pairing" || !this.currentPairingCode) {
					console.warn("E2EE: Received 'exchange' message in unexpected state.")
					this.sendPairingError("internal_error", "Received exchange in wrong state")
					return
				}
				if (!payload || typeof payload !== "object" || !("webuiPublicKey" in payload)) {
					console.error("E2EE: Invalid 'exchange' payload received.")
					this.sendPairingError("internal_error", "Invalid exchange payload")
					this.resetPairingState()
					return
				}
				const exchangePayload = payload as PairingExchangePayload

				try {
					await sodium.ready // Ensure sodium is ready
					const peerPublicKeyBytes = sodium.from_base64(
						exchangePayload.webuiPublicKey,
						sodium.base64_variants.URLSAFE_NO_PADDING,
					)
					const receivedHash = exchangePayload.verificationHash

					// Verify hash
					const expectedHash = await crypto.computeVerificationHash(
						this.keyPair.publicKey,
						peerPublicKeyBytes,
						this.currentPairingCode,
					)

					if (expectedHash !== receivedHash) {
						console.error("E2EE: Pairing verification hash mismatch!")
						vscode.window.showErrorMessage("Pairing failed: Verification code mismatch. Please try again.")
						this.sendPairingError("hash_mismatch")
						this.resetPairingState()
						return
					}

					// Hash matches - derive and store secrets
					console.log("E2EE: Verification hash matches. Deriving shared secret...")
					const derivedSecret = await crypto.deriveSharedSecretClient(
						this.keyPair.publicKey,
						this.keyPair.privateKey,
						peerPublicKeyBytes,
					)

					// Use sessionId as the peer identifier
					this.peerId = this.config.sessionId
					if (!this.peerId) {
						throw new Error("Session ID is missing, cannot complete pairing.")
					}

					await crypto.storePeerPublicKey(this.context, this.peerId, peerPublicKeyBytes)
					await crypto.storeSharedSecret(this.context, this.peerId, derivedSecret)

					// Pairing successful!
					this.sharedSecret = derivedSecret
					this.pairingState = "paired"
					this.clearPairingAttemptState() // Clear code and timeout

					console.log(`E2EE: Pairing successful with peer ${this.peerId}!`)
					vscode.window.showInformationMessage("Successfully paired with Web UI.")
					this.emit("pairing_status_changed", this.pairingState)

					// Send completion message to peer
					await this.sendPairingMessage("complete")
				} catch (err) {
					console.error("E2EE: Error processing 'exchange' message:", err)
					vscode.window.showErrorMessage(
						`Pairing failed during key exchange: ${err instanceof Error ? err.message : err}`,
					)
					this.sendPairingError("internal_error", `Exchange processing failed: ${err}`)
					this.resetPairingState()
				}
				break

			case "error":
				if (!payload || typeof payload !== "object" || !("reason" in payload)) {
					console.error("E2EE: Invalid 'error' payload received.")
					return // Don't reset state based on invalid error
				}
				const errorPayload = payload as PairingErrorPayload
				console.error(`E2EE: Received pairing error from peer: ${errorPayload.reason}`, errorPayload.message)
				vscode.window.showErrorMessage(`Pairing failed: ${errorPayload.message || errorPayload.reason}`)
				this.resetPairingState() // Reset state on error from peer
				break

			// 'start' and 'complete' are typically sent, not received by extension
			case "start":
			case "complete":
				console.warn(`E2EE: Received unexpected pairing action '${action}' from peer.`)
				break
			default:
				console.warn(`E2EE: Received unknown pairing action: ${action}`)
		}
	}

	/** Sends a pairing message */
	private async sendPairingMessage(action: PairingAction, payload?: any): Promise<void> {
		const message: Omit<WebSocketMessage, "id"> = {
			type: "pairing",
			action: action,
			clientType: "extension",
		}
		// Use pairingPayload field for typed payloads
		if (payload) {
			message.pairingPayload = payload
		}
		await this.send(message) // Use the main send method (which handles queueing etc.)
	}

	/** Sends a pairing error message to the peer */
	private async sendPairingError(
		reason: PairingErrorPayload["reason"],
		message?: string,
		peerId?: string, // Optional: Target specific peer if needed
	): Promise<void> {
		const errorPayload: PairingErrorPayload = { reason, message }
		await this.sendPairingMessage("error", errorPayload)
	}

	/** Clears pairing attempt state (code, timeout) */
	private clearPairingAttemptState() {
		if (this.pairingTimeout) {
			clearTimeout(this.pairingTimeout)
			this.pairingTimeout = null
		}
		this.currentPairingCode = null
	}

	/** Resets the entire pairing state to unpaired */
	private resetPairingState() {
		console.log("E2EE: Resetting pairing state.")
		this.clearPairingAttemptState()
		// Should we clear the stored secret/peer key on reset? Maybe add a separate 'revoke' action.
		// For now, just reset the in-memory state.
		this.sharedSecret = null
		// Keep peerId if we want to potentially resume later? Or clear it? Let's clear for now.
		// this.peerId = null; // Reconsider if peerId should persist across resets
		if (this.pairingState !== "unpaired") {
			this.pairingState = "unpaired"
			this.emit("pairing_status_changed", this.pairingState)
		}
	}

	// --- Message Handling ---

	private async handleIncomingMessage(data: WebSocket.Data) {
		let message: WebSocketMessage
		try {
			message = JSON.parse(data.toString())
		} catch (err) {
			console.error("Failed to parse WebSocket message:", err)
			vscode.window.showErrorMessage("Failed to parse WebSocket message")
			return
		}

		// Check for encrypted payload
		if (message.encryptedPayload && this.pairingState === "paired" && this.sharedSecret) {
			console.log("Received encrypted message, attempting decryption:", message.id)
			try {
				const decryptedPayload = await crypto.decryptPayload<unknown>(
					message.encryptedPayload,
					this.sharedSecret,
				)
				if (decryptedPayload !== null) {
					// Replace encrypted payload with decrypted one
					const decryptedMessage: WebSocketMessage = {
						...message,
						payload: decryptedPayload,
					}
					delete decryptedMessage.encryptedPayload // Remove the encrypted part
					console.log("Decryption successful, emitting message:", decryptedMessage.id)
					this.emit("message", decryptedMessage)
				} else {
					console.error("Decryption failed for message:", message.id)
					// Optionally emit an error or handle failed decryption
					this.emit("e2ee_error", new Error(`Decryption failed for message ${message.id}`))
				}
			} catch (err) {
				console.error("Error during decryption:", err)
				this.emit("e2ee_error", new Error(`Decryption error for message ${message.id}`))
			}
		} else if (message.encryptedPayload) {
			console.warn("Received encrypted message but not paired or no shared secret:", message.id)
			// Decide how to handle - discard, error, etc.
		} else {
			// Handle non-encrypted messages (e.g., pairing messages, errors)
			// Handle pairing messages separately
			if (message.type === "pairing") {
				await this.handlePairingMessage(message)
			} else {
				// Emit other unencrypted messages
				console.log("Received unencrypted non-pairing message:", message)
				this.emit("message", message)
			}
		}
	}

	public async send(message: Omit<WebSocketMessage, "id">): Promise<void> {
		const messageWithId: WebSocketMessage = {
			...message,
			id: uuidv4(),
		}

		// Encryption logic
		let messageToSend = messageWithId
		if (this.pairingState === "paired" && this.sharedSecret && messageToSend.payload) {
			// Don't encrypt pairing control messages themselves
			const isPairingMessage = messageToSend.type === "pairing"
			if (!isPairingMessage) {
				try {
					console.log("Encrypting payload for message:", messageToSend.id)
					const encryptedPayload = await crypto.encryptPayload(messageToSend.payload, this.sharedSecret)
					// Create a new message object for sending, preserving metadata
					messageToSend = {
						id: messageToSend.id,
						type: messageToSend.type,
						action: messageToSend.action,
						clientType: messageToSend.clientType,
						// Add other metadata fields if necessary
						encryptedPayload: encryptedPayload,
						// Original payload is removed
					}
					console.log("Payload encrypted:", messageToSend.id)
				} catch (err) {
					console.error("Failed to encrypt message payload:", err)
					this.emit("e2ee_error", new Error(`Encryption failed for message ${messageToSend.id}`))
					// Decide whether to send unencrypted or reject
					return Promise.reject(new Error("Encryption failed"))
				}
			}
		} else if (messageToSend.payload && this.pairingState !== "paired") {
			// Potentially sensitive payload being sent unencrypted?
			// Add checks or warnings if needed based on message type/payload content
			console.warn("Sending message with payload unencrypted (not paired):", messageToSend.id)
		}

		// Queueing and Sending logic
		return new Promise((resolve, reject) => {
			if (this.connectionState !== "connected") {
				console.log("Queueing message (not connected):", messageToSend.id)
				this.messageQueue.push({ message: messageToSend, resolve, reject })
				return
			}

			try {
				const messageString = JSON.stringify(messageToSend)
				console.log("Sending message:", messageToSend.id, "(encrypted:", !!messageToSend.encryptedPayload, ")")
				this.socket?.send(messageString)
				resolve()
			} catch (err) {
				console.error("Failed to send message:", err)
				reject(err)
			}
		})
	}

	private flushMessageQueue() {
		while (this.messageQueue.length > 0) {
			const { message, resolve, reject } = this.messageQueue.shift()!
			this.send(message).then(resolve).catch(reject)
		}
	}

	public disconnect() {
		console.log("Disconnecting WebSocket")
		this.socket?.close()
		this.connectionState = "disconnected"
	}
}
