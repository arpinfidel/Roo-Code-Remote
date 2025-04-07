import { v4 as uuidv4 } from "uuid"
import { WebSocketClient } from "./client"
import { API } from "../../exports/api"
import { webviewMessageHandler } from "../../core/webview/webviewMessageHandler"
import { WebviewMessage } from "../../shared/WebviewMessage"
import * as vscode from "vscode"
import { WebSocketConfig, WebSocketMessage } from "./types"
import { ExtensionMessage } from "../../shared/ExtensionMessage"

export class WebSocketApiAdapter {
	private wsClient: WebSocketClient
	private api: API
	private config: WebSocketConfig // Store config

	constructor(api: API, config: WebSocketConfig) {
		this.api = api
		this.config = config // Store config
		const wsClient = new WebSocketClient({
			serverUrl: config.serverUrl || "",
			provider: config.provider, // Pass provider instead of authToken
			reconnectInterval: config.reconnectInterval || 5000,
			maxRetries: config.maxRetries || 5,
			clientType: "extension",
			sessionId: config.sessionId,
		})
		this.wsClient = wsClient

		// Setup state change listeners
		this.wsClient.on("connecting", () => {
			this.api.getProvider()?.notifyWebSocketStateChange("connecting")
		})
		this.wsClient.on("connected", () => {
			this.api.getProvider()?.notifyWebSocketStateChange("connected")
		})
		this.wsClient.on("disconnected", () => {
			this.api.getProvider()?.notifyWebSocketStateChange("disconnected")
		})
		this.wsClient.on("error", () => {
			this.api.getProvider()?.notifyWebSocketStateChange("error")
		})

		// Only connect automatically if clientType is 'webui'
		if (this.config.clientType === "webui") {
			this.setupConnection()
		} else {
			console.log("WebSocket connection deferred for manual initiation (extension mode).")
		}
	}

	private setupConnection() {
		this.wsClient
			.connect()
			.then(() => {
				vscode.window.showInformationMessage(`WebSocket connection successful`)
			})
			.catch((err) => {
				vscode.window.showErrorMessage(`WebSocket connection unsuccessful: ${err.message} ${err}`)
			})

		this.wsClient.on("message", (message: WebSocketMessage) => {
			console.log("ws-client: received message", message)
			switch (message.type) {
				case "vscode-message":
					this.webviewCommand(message)
						.then((result) => {
							this.wsClient.send({
								id: message.id,
								type: "response",
								status: "completed",
								payload: result,
							} as WebSocketMessage)
						})
						.catch((error) => {
							this.wsClient.send({
								id: message.id,
								type: "response",
								status: "error",
								error: error.message,
							} as WebSocketMessage)
						})
					break
				case "client-connected":
					const provider = this.api.getProvider()
					provider.getStateToPostToWebview().then((state) => {
						provider.emit("messageToWebview", { type: "state", state })
					})
					break
			}
		})

		this.wsClient.on("error", (err) => {
			vscode.window.showErrorMessage(`WebSocket connection error: ${err.message} ${err}`)
		})
	}

	public forwardMessageEvent(event: ExtensionMessage) {
		this.wsClient.send({
			type: "vscode-event",
			id: uuidv4(),
			payload: event,
		} as WebSocketMessage)
	}

	private async webviewCommand(message: WebSocketMessage): Promise<any> {
		const provider = this.api.getProvider()
		if (!provider) {
			return { status: "no_provider" }
		}

		try {
			const webviewMsg: WebviewMessage = {
				type: message.type,
				text: message.payload?.text,
				images: message.payload?.images,
				...message.payload,
			}

			await webviewMessageHandler(provider, webviewMsg)
			return { status: "processed" }
		} catch (err) {
			console.error("Error forwarding WebSocket message:", err)
			return {
				status: "error",
				error: err instanceof Error ? err.message : String(err),
			}
		}
	}

	public updateConfig(config: WebSocketConfig) {
		this.config = config // Update stored config
		this.wsClient.disconnect()
		this.wsClient = new WebSocketClient({
			serverUrl: config.serverUrl || "",
			provider: config.provider, // Pass provider instead of authToken
			reconnectInterval: config.reconnectInterval || 5000,
			maxRetries: config.maxRetries || 5,
			clientType: "extension",
			sessionId: config.sessionId,
		})
		// Only reconnect automatically if clientType is 'webui'
		if (this.config.clientType === "webui") {
			this.setupConnection()
		} else {
			console.log("WebSocket connection deferred after config update (extension mode).")
		}
	}

	/**
	 * Manually initiates the WebSocket connection and sets up listeners.
	 * Intended for use when clientType is 'extension'.
	 */
	public connectManually() {
		if (this.config.clientType !== "extension") {
			console.warn("connectManually called, but clientType is not 'extension'.")
			// Optionally connect anyway or just return
		}
		console.log("Manually initiating WebSocket connection...")
		this.setupConnection()
	}
}
