import { v4 as uuidv4 } from "uuid"

type WsStatus = "disconnected" | "connecting" | "connected"

// Export WsMessage interface
export interface WsMessage {
	id: string
	type: string
	action?: string
	payload?: unknown
	error?: string
	clientType?: "webui" | "extension"
}

type WsEvent = "connected" | "disconnected" | "message" | "error"

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

	setURL(url: string): this { // Return this for chaining
		this.url = new URL(url)
		return this
	}

	setClientType(type: "webui" | "extension"): this { // Return this
		this.clientType = type
		return this
	}

	setSessionId(sessionId: string | null): this { // Return this
		this.sessionId = sessionId
		return this
	}

	setAuthToken(token: string | null): this { // Return this
		this.authToken = token
		return this
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

			this.socket.onmessage = (event) => {
				try {
					const message = JSON.parse(event.data.toString()) as WsMessage
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

	send(message: Omit<WsMessage, "id">): Promise<void> {
		return new Promise((resolve, reject) => {
			const messageWithId = {
				...message,
				id: uuidv4(),
			}

			if (this.status !== "connected") {
				this.queue.push(messageWithId)
				return
			}

			try {
				this.socket?.send(JSON.stringify(messageWithId))
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
