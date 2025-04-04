import { v4 as uuidv4 } from "uuid"

type WsStatus = "disconnected" | "connecting" | "connected"

interface WsMessage {
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
	private url: string = ""
	private eventTarget = new EventTarget()
	private sessionId: string | null = null

	setClientType(type: "webui" | "extension") {
		this.clientType = type
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

	connect(url: string): Promise<void> {
		this.url = url
		return new Promise((resolve, reject) => {
			if (this.status === "connected") {
				return resolve()
			}

			this.status = "connecting"
			this.socket = new WebSocket(url)

			if (!this.socket) {
				return reject(new Error("Failed to create WebSocket"))
			}

			this.socket.onopen = () => {
				this.status = "connected"
				// Check if we have a session ID from the window object (for web UI)
				if (typeof window !== "undefined" && (window as any).ROO_SESSION_ID) {
					this.sessionId = (window as any).ROO_SESSION_ID
				}

				this.send({
					type: "client-identify",
					clientType: this.clientType,
					payload: {
						sessionId: this.sessionId,
					},
				}).catch(console.error)
				this.flushQueue()
				this.emit("connected")
				resolve()
			}

			this.socket.onmessage = (event) => {
				try {
					const message = JSON.parse(event.data) as WsMessage
					// this.emit("message", message.payload)
					const ev = new MessageEvent("message", {
						data: message.payload,
					})
					window.dispatchEvent(ev)
				} catch (err) {
					this.emit("error", new Error("Failed to parse message"))
				}
			}

			this.socket.onclose = () => {
				this.status = "disconnected"
				this.emit("disconnected")
				this.reconnect()
			}

			this.socket.onerror = (error) => {
				this.status = "disconnected"
				this.emit("error", error)
				reject(error)
			}
		})
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
		setTimeout(() => this.connect(this.url), 5000)
	}

	disconnect() {
		this.socket?.close()
		this.status = "disconnected"
	}

	getStatus(): WsStatus {
		return this.status
	}
}
