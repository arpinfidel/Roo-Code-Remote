import { v4 as uuidv4 } from "uuid"
import { E2EECrypto } from "./crypto"

type WsStatus = "disconnected" | "connecting" | "connected"

interface WsMessage {
	id: string
	type: string
	action?: string
	payload?: unknown
	error?: string
	clientType?: "webui" | "extension"
	encrypted?: boolean // Flag indicating if payload is encrypted
	iv?: string // Initialization vector for AES-GCM
	keyId?: string // ID of encryption key used
}

type WsEvent = "connected" | "disconnected" | "message" | "error" | "paired"

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
	private crypto = new E2EECrypto()
	private isPaired = false
	private sharedKey?: JsonWebKey
	private pairingCode?: string
	private keyPair?: { publicKey: JsonWebKey, privateKey: JsonWebKey, keyId: string }

	async startPairingFlow(): Promise<void> {
		// Generate and display pairing code
		this.pairingCode = await this.crypto.generatePairingCode()
		
		// Send pairing request to extension via message passing
		window.postMessage({
			type: 'pairing-start',
			code: this.pairingCode
		}, '*')

		// Generate key pair for this session
		this.keyPair = await this.crypto.generateKeyPair()
	}

	async completePairingWithCode(enteredCode: string): Promise<void> {
		// Verify code matches
		if (enteredCode !== this.pairingCode) {
			throw new Error('Invalid pairing code')
		}

		if (!this.keyPair) {
			throw new Error('Key pair not generated')
		}

		// Exchange public keys with extension
		window.postMessage({
			type: 'pairing-exchange',
			publicKey: this.keyPair.publicKey
		}, '*')
	}

	async handleExtensionResponse(message: any) {
		if (message.type === 'pairing-exchange-response' && this.keyPair) {
			// Derive shared key from extension's public key
			this.sharedKey = (await this.crypto.deriveSharedKey(
				message.publicKey,
				this.keyPair,
				message.keyId
			)).key
			
			this.isPaired = true
			this.emit("paired")
		}
	}

	private async encryptMessage(message: WsMessage): Promise<WsMessage> {
		if (!this.isPaired || !this.sharedKey) return message
		return this.crypto.encryptMessage(message, this.sharedKey)
	}

	private async decryptMessage(message: WsMessage): Promise<WsMessage> {
		if (!message.encrypted || !this.sharedKey) return message
		return this.crypto.decryptMessage(message, this.sharedKey)
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

			this.socket.onmessage = async (event) => {
				try {
					let message = JSON.parse(event.data.toString()) as WsMessage

					// Handle pairing messages through extension response handler
					if (message.type === "pairing-exchange-response") {
						await this.handleExtensionResponse(message)
						return
					}

					// Decrypt message if needed
					message = await this.decryptMessage(message)

					if (message.type !== "vscode-event") {
						return
					}

					const ev = new MessageEvent("message", {
						data: message.payload,
					})
					window.dispatchEvent(ev)
				} catch (err) {
					this.emit("error", new Error("Failed to parse message"))
				}
			}

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

	async send(message: Omit<WsMessage, "id">): Promise<void> {
		return new Promise(async (resolve, reject) => {
			try {
				const messageWithId = {
					...message,
					id: uuidv4(),
				}

				if (this.status !== "connected") {
					this.queue.push(messageWithId)
					return
				}

				// Encrypt message if paired
				const finalMessage = await this.encryptMessage(messageWithId)
				this.socket?.send(JSON.stringify(finalMessage))
				resolve()
			} catch (err) {
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
