import { EventEmitter } from "events"
import WebSocket from "ws"
import { v4 as uuidv4 } from "uuid"
import * as vscode from "vscode"

import { WebSocketConfig, WebSocketMessage } from "./types"

type MessageHandler = (message: WebSocketMessage) => void
type ErrorHandler = (error: Error) => void

export class WebSocketClient extends EventEmitter {
	private socket: WebSocket | null = null
	private retryCount = 0
	private connectionState: "disconnected" | "connecting" | "connected" = "disconnected"
	private config: WebSocketConfig
	private messageQueue: Array<{
		message: WebSocketMessage
		resolve: () => void
		reject: (reason?: any) => void
	}> = []
	private url: URL = new URL("http://localhost")

	constructor(config: WebSocketConfig) {
		super()
		this.config = config
		this.url = new URL(config.serverUrl)
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

			this.socket = new WebSocket(this.url, {
				headers: {
					Authorization: `Bearer ${this.config.authToken}`,
				},
			})

			this.socket.on("open", () => {
				this.connectionState = "connected"
				this.retryCount = 0
				this.flushMessageQueue()
				this.emit("connected")
				resolve()
			})

			this.socket.on("message", (data: WebSocket.Data) => {
				try {
					const message = JSON.parse(data.toString())
					console.log("Received message:", message)
					this.emit("message", message)
				} catch (err) {
					console.error("Failed to parse WebSocket message:", err)
					vscode.window.showErrorMessage("Failed to parse WebSocket message")
				}
			})

			this.socket.on("close", () => {
				this.connectionState = "disconnected"
				console.log("WebSocket connection closed")
				this.emit("disconnected")
				this.handleReconnect()
			})

			this.socket.on("error", (err: Error) => {
				this.connectionState = "disconnected"
				console.error("WebSocket error:", err)
				this.emit("error", err)
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

	public send(message: WebSocketMessage): Promise<void> {
		return new Promise((resolve, reject) => {
			const messageWithId = {
				...message,
				id: uuidv4(),
			}

			if (this.connectionState !== "connected") {
				this.messageQueue.push({ message: messageWithId, resolve, reject })
				return
			}

			try {
				console.log("Sending message:", messageWithId)
				this.socket?.send(JSON.stringify(messageWithId))
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
