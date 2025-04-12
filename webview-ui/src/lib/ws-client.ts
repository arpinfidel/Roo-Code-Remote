import { v4 as uuidv4 } from "uuid"
import * as crypto from "./crypto" // Import crypto utils
// Use sodium directly for base64 conversion
import sodium from "libsodium-wrappers"

type WsStatus = "disconnected" | "connecting" | "connected"
type PairingState = "unpaired" | "pairing" | "paired" | "error"

// Define message types and actions locally, mirroring extension types
// Ideally, these should be shared in a common package.
type WsMessageType =
	| "command"
	| "response"
	| "event"
	| "vscode-message"
	| "vscode-event"
	| "client-connected"
	| "pairing"

type PairingAction = "start" | "exchange" | "complete" | "error"

// Define payload interfaces locally (mirroring types.ts)
interface PairingStartPayload {
	extensionPublicKey: string
}
interface PairingExchangePayload {
	webuiPublicKey: string
	verificationHash: string
}
interface PairingErrorPayload {
	reason: string
	message?: string
}

interface WsMessage {
	id: string
	type: WsMessageType
	action?: string | PairingAction // Allow specific pairing actions
	payload?: unknown
	error?: string
	clientType?: "webui" | "extension"
	encryptedPayload?: crypto.EncryptedPayload
	pairingPayload?: PairingStartPayload | PairingExchangePayload | PairingErrorPayload // Add pairing payload
}

type WsEvent = "connected" | "disconnected" | "message" | "error" | "e2ee_error" | "pairing_status_changed"

export class WsClient {
	private clientType: "webui" | "extension" = "webui"
	private socket: WebSocket | null = null
	private status: WsStatus = "disconnected"
	private queue: WsMessage[] = []
	private url: URL = new URL("http://localhost")
	private eventTarget = new EventTarget()
	private sessionId: string | null = null
	private authToken: string | null = null
	private connectingPromise: Promise<void> | null = null

	// E2EE State
	private keyPair: crypto.KeyPair | null = null
	private peerId: string | null = null // Identifier for the paired peer (e.g., extension instance ID)
	private sharedSecret: Uint8Array | null = null
	private pairingState: PairingState = "unpaired"
	private currentPeerPublicKey: Uint8Array | null = null // Store peer key during pairing

	constructor() {
		this.initializeE2EE().catch((err) => {
			console.error("Failed to initialize WebUI E2EE:", err)
			this.pairingState = "error"
			this.emit("e2ee_error", err)
		})
	}

	private async initializeE2EE() {
		this.keyPair = await crypto.getOrCreateKeyPair()
		this.keyPair = await crypto.getOrCreateKeyPair()
		console.log("E2EE Key Pair loaded/generated for WebUI.")

		// Attempt to load existing pairing info (use a fixed peerId for now, e.g., 'extension')
		// TODO: Determine a better way to identify the specific extension instance if needed
		this.peerId = "extension" // Simple identifier for the single peer
		this.sharedSecret = await crypto.getSharedSecret(this.peerId)
		if (this.sharedSecret) {
			this.pairingState = "paired"
			console.log(`E2EE: Resumed paired state with peer ${this.peerId}`)
		} else {
			this.pairingState = "unpaired"
			console.log(`E2EE: No existing shared secret found for peer ${this.peerId}`)
		}
		this.emit("pairing_status_changed", this.pairingState)
	}

	setURL(url: string) {
		this.url = new URL(url)
		return this
	}

	setClientType(type: "webui" | "extension") {
		this.clientType = type
		return this
	}

	setSessionId(sessionId: string | null) {
		this.sessionId = sessionId
	}

	setAuthToken(token: string | null) {
		this.authToken = token
	}

	on(event: WsEvent, listener: (event: CustomEvent) => void) {
		this.eventTarget.addEventListener(event, listener as EventListener)
	}

	off(event: WsEvent, listener: (event: CustomEvent) => void) {
		this.eventTarget.removeEventListener(event, listener as EventListener)
	}

	private emit(event: WsEvent, detail?: unknown) {
		this.eventTarget.dispatchEvent(new CustomEvent(event, { detail }))
	}

	connect(): Promise<void> {
		if (this.connectingPromise) {
			return this.connectingPromise
		}
		if (this.sessionId) {
			this.url.searchParams.set("session_id", this.sessionId)
		}
		if (this.clientType) {
			this.url.searchParams.set("client_type", this.clientType)
		}
		if (this.authToken) {
			this.url.searchParams.set("auth_token", this.authToken)
		}
		this.connectingPromise = new Promise((resolve, reject) => {
			if (this.status === "connected") {
				return resolve()
			}
			console.log("Attempting WebSocket connection to:", this.url)

			this.status = "connecting"
			try {
				this.socket = new WebSocket(this.url)
				console.log("WebSocket instance created, setting up event handlers...")
			} catch (err) {
				console.error("Error creating WebSocket:", err)
				this.emit("error", err as Error)
				return reject(err as Error)
			}

			if (!this.socket) {
				const err = new Error("Failed to create WebSocket instance")
				console.error(err)
				this.emit("error", err)
				return reject(err)
			}

			this.socket.onopen = () => {
				console.log("WebSocket connection established")
				console.log("Connection details:", {
					url: this.socket?.url,
					protocol: this.socket?.protocol,
					extensions: this.socket?.extensions,
				})
				this.status = "connected"
				this.flushQueue()
				this.emit("connected")
				resolve()
			}

			this.socket.onmessage = (event) => this.handleIncomingMessage(event.data)

			this.socket.onclose = (event) => {
				console.log("WebSocket closed:", {
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
				})
				this.status = "disconnected"
				this.emit("disconnected", event)
				this.reconnect()
			}

			this.socket.onerror = (error) => {
				this.status = "disconnected"
				this.emit("error", error)
				reject(error)
			}
		})

		return this.connectingPromise
	}

	// --- Pairing Logic ---

	/**
	 * Handles the pairing process when the user submits the code.
	 * Calculates hash, derives secret, sends 'exchange' message.
	 * @param pairingCode The code entered by the user.
	 */
	public async submitPairingCode(pairingCode: string): Promise<void> {
		if (this.pairingState !== "pairing" || !this.keyPair || !this.currentPeerPublicKey) {
			console.error("Cannot submit pairing code in current state:", this.pairingState)
			this.emit("e2ee_error", new Error("Not in pairing state or keys missing."))
			this.resetPairingState() // Reset if attempted in wrong state
			return
		}

		console.log("E2EE: Pairing code submitted, calculating hash and deriving secret...")

		try {
			await sodium.ready // Ensure sodium is ready

			// Compute verification hash
			const verificationHash = await crypto.computeVerificationHash(
				this.currentPeerPublicKey, // Peer's key comes first in WebUI calculation
				this.keyPair.publicKey,
				pairingCode,
			)

			// Derive shared secret (WebUI acts as 'server' in key exchange)
			const derivedSecret = await crypto.deriveSharedSecretServer(
				this.keyPair.publicKey,
				this.keyPair.privateKey,
				this.currentPeerPublicKey,
			)

			// Store the derived secret *temporarily* until confirmed by 'complete' message
			// Or should we store it now? Let's store it now and clear on error.
			this.sharedSecret = derivedSecret
			// Assume fixed peerId 'extension' for now
			this.peerId = "extension"
			await crypto.storeSharedSecret(this.peerId, derivedSecret)
			// Also store peer's public key permanently now
			await crypto.storePeerPublicKey(this.peerId, this.currentPeerPublicKey)

			console.log("E2EE: Shared secret derived. Sending 'exchange' message.")

			// Send 'exchange' message
			const payload: PairingExchangePayload = {
				webuiPublicKey: sodium.to_base64(this.keyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
				verificationHash: verificationHash,
			}
			await this.sendPairingMessage("exchange", payload)

			// State remains 'pairing' until 'complete' is received
		} catch (err) {
			console.error("E2EE: Error during pairing code submission:", err)
			this.emit("e2ee_error", new Error(`Pairing failed: ${err instanceof Error ? err.message : err}`))
			this.sendPairingError("internal_error", `Code submission failed: ${err}`)
			this.resetPairingState()
		}
	}

	private async handlePairingMessage(message: WsMessage) {
		if (!this.keyPair) {
			console.error("E2EE: Received pairing message but keypair is not initialized.")
			return
		}

		const action = message.action as PairingAction
		const payload = message.pairingPayload

		console.log(`E2EE: Received pairing message - Action: ${action}`)

		switch (action) {
			case "start":
				if (this.pairingState === "paired") {
					console.warn("E2EE: Received 'start' while already paired. Ignoring.")
					// Optionally send an error back?
					// this.sendPairingError("already_paired", "Web UI is already paired.");
					return
				}
				if (!payload || typeof payload !== "object" || !("extensionPublicKey" in payload)) {
					console.error("E2EE: Invalid 'start' payload received.")
					this.sendPairingError("internal_error", "Invalid start payload")
					return
				}
				const startPayload = payload as PairingStartPayload

				try {
					await sodium.ready
					this.currentPeerPublicKey = sodium.from_base64(
						startPayload.extensionPublicKey,
						sodium.base64_variants.URLSAFE_NO_PADDING,
					)
					this.pairingState = "pairing"
					console.log("E2EE: Pairing initiated by extension. Ready for code input.")
					this.emit("pairing_status_changed", this.pairingState)
					// UI should now prompt for the code based on the 'pairing' state
				} catch (err) {
					console.error("E2EE: Error processing 'start' message:", err)
					this.emit("e2ee_error", new Error("Failed to process pairing start"))
					this.resetPairingState()
				}
				break

			case "complete":
				if (this.pairingState !== "pairing" || !this.sharedSecret) {
					console.warn("E2EE: Received 'complete' message in unexpected state.")
					// Don't reset state here, might be a delayed message
					return
				}
				// Pairing confirmed by extension!
				this.pairingState = "paired"
				this.currentPeerPublicKey = null // Clear temporary peer key
				console.log("E2EE: Pairing successfully completed and confirmed by extension!")
				this.emit("pairing_status_changed", this.pairingState)
				// UI should update to show 'Paired' status
				break

			case "error":
				if (!payload || typeof payload !== "object" || !("reason" in payload)) {
					console.error("E2EE: Invalid 'error' payload received.")
					return // Don't reset state based on invalid error
				}
				const errorPayload = payload as PairingErrorPayload
				console.error(`E2EE: Received pairing error from peer: ${errorPayload.reason}`, errorPayload.message)
				this.emit("e2ee_error", new Error(`Pairing failed: ${errorPayload.message || errorPayload.reason}`))
				this.resetPairingState() // Reset state on error from peer
				break

			// 'exchange' is typically sent, not received by WebUI
			case "exchange":
				console.warn(`E2EE: Received unexpected pairing action '${action}' from peer.`)
				break
			default:
				console.warn(`E2EE: Received unknown pairing action: ${action}`)
		}
	}

	/** Sends a pairing message */
	private async sendPairingMessage(action: PairingAction, payload?: any): Promise<void> {
		const message: Omit<WsMessage, "id"> = {
			type: "pairing",
			action: action,
			clientType: this.clientType,
		}
		if (payload) {
			message.pairingPayload = payload
		}
		await this.send(message)
	}

	/** Sends a pairing error message to the peer */
	private async sendPairingError(reason: string, message?: string): Promise<void> {
		const errorPayload: PairingErrorPayload = { reason, message }
		await this.sendPairingMessage("error", errorPayload)
	}

	/** Resets the pairing state */
	private resetPairingState() {
		console.log("E2EE: Resetting pairing state.")
		this.currentPeerPublicKey = null
		// Clear stored secret and peer key on reset? Or require explicit revoke?
		// Let's clear them for now on reset for simplicity.
		if (this.peerId) {
			crypto.storeSharedSecret(this.peerId, null as any) // Clear stored secret
			crypto.storePeerPublicKey(this.peerId, null as any) // Clear stored peer key
		}
		this.sharedSecret = null
		this.peerId = null // Clear peerId as well

		if (this.pairingState !== "unpaired") {
			this.pairingState = "unpaired"
			this.emit("pairing_status_changed", this.pairingState)
		}
	}

	// --- Message Handling ---

	private async handleIncomingMessage(data: string | Blob | ArrayBuffer) {
		let message: WsMessage
		try {
			// Handle different data types from WebSocket
			let messageString: string
			if (data instanceof Blob) {
				messageString = await data.text()
			} else if (data instanceof ArrayBuffer) {
				messageString = new TextDecoder().decode(data)
			} else {
				messageString = data
			}
			message = JSON.parse(messageString)
		} catch (err) {
			console.error("Failed to parse WebSocket message:", err)
			this.emit("error", new Error("Failed to parse message"))
			return
		}

		// Decryption Logic
		if (message.encryptedPayload && this.pairingState === "paired" && this.sharedSecret) {
			console.log("Received encrypted message, attempting decryption:", message.id)
			try {
				const decryptedPayload = await crypto.decryptPayload<unknown>(
					message.encryptedPayload,
					this.sharedSecret,
				)
				if (decryptedPayload !== null) {
					const decryptedMessage: WsMessage = { ...message, payload: decryptedPayload }
					delete decryptedMessage.encryptedPayload
					console.log("Decryption successful, emitting message:", decryptedMessage.id)
					this.emit("message", new CustomEvent("message", { detail: decryptedMessage }))
					// Special handling for vscode-event type for backward compatibility?
					if (decryptedMessage.type === "vscode-event") {
						window.dispatchEvent(new MessageEvent("message", { data: decryptedMessage.payload }))
					}
				} else {
					console.error("Decryption failed for message:", message.id)
					this.emit("e2ee_error", new Error(`Decryption failed for message ${message.id}`))
				}
			} catch (err) {
				console.error("Error during decryption:", err)
				this.emit("e2ee_error", new Error(`Decryption error for message ${message.id}`))
			}
		} else if (message.encryptedPayload) {
			console.warn("Received encrypted message but not paired or no shared secret:", message.id)
		} else {
			// Handle pairing messages separately
			if (message.type === "pairing") {
				await this.handlePairingMessage(message)
			} else {
				// Emit other unencrypted messages
				console.log("Received unencrypted non-pairing message:", message)
				this.emit("message", new CustomEvent("message", { detail: message }))
				// Special handling for vscode-event type
				if (message.type === "vscode-event") {
					window.dispatchEvent(new MessageEvent("message", { data: message.payload }))
				}
			}
		}
	}

	async send(message: Omit<WsMessage, "id">): Promise<void> {
		const messageWithId: WsMessage = {
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
					messageToSend = {
						id: messageToSend.id,
						type: messageToSend.type,
						action: messageToSend.action,
						clientType: this.clientType, // Ensure clientType is set
						encryptedPayload: encryptedPayload,
					}
					console.log("Payload encrypted:", messageToSend.id)
				} catch (err) {
					console.error("Failed to encrypt message payload:", err)
					this.emit("e2ee_error", new Error(`Encryption failed for message ${messageToSend.id}`))
					return Promise.reject(new Error("Encryption failed"))
				}
			}
		} else if (messageToSend.payload && this.pairingState !== "paired") {
			console.warn("Sending message with payload unencrypted (not paired):", messageToSend.id)
		}

		// Queueing and Sending logic
		return new Promise((resolve, reject) => {
			if (this.status !== "connected") {
				console.log("Queueing message (not connected):", messageToSend.id)
				this.queue.push(messageToSend)
				// Don't resolve/reject here, it will be sent when connected
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

	private flushQueue() {
		while (this.queue.length > 0) {
			const message = this.queue.shift()
			if (message) {
				this.send(message).catch(console.error)
			}
		}
	}

	private reconnect() {
		setTimeout(() => this.connect(), 5000)
	}

	disconnect() {
		this.socket?.close()
		this.status = "disconnected"
	}

	getStatus(): WsStatus {
		return this.status
	}
}
