import { v4 as uuidv4 } from "uuid"
import { WebSocketClient } from "./client"
import { API } from "../../exports/api"
import { webviewMessageHandler } from "../../core/webview/webviewMessageHandler"
import { WebviewMessage } from "../../shared/WebviewMessage"
import * as vscode from "vscode"
import { RooCodeSettings, WebSocketConfig, WebSocketMessage, WebSocketMessageType } from "./types"
import { ExtensionMessage } from "../../shared/ExtensionMessage"

export class WebSocketApiAdapter {
	private wsClient: WebSocketClient
	private api: API

	constructor(api: API, config: Partial<WebSocketConfig>) {
		this.api = api
		const wsClient = new WebSocketClient({
			serverUrl: config.serverUrl || "",
			authToken: config.authToken || "",
			reconnectInterval: config.reconnectInterval || 5000,
			maxRetries: config.maxRetries || 5,
		})
		wsClient.setClientType("extension")
		this.wsClient = wsClient
		this.setupConnection()
	}

	private setupConnection() {
		this.wsClient.connect().catch((err) => {
			vscode.window.showErrorMessage(`WebSocket connection failed: ${err.message}`)
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

				case "vscode-event":
					this.sendToWebUI(message.payload)
					break
			}
		})
	}

	public forwardMessageEvent(event: ExtensionMessage) {
		this.api.log(`Forwarding event: ${event.type}`)
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
				type: message.action,
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

	private async sendToWebUI(message: ExtensionMessage) {
		console.log(message)
		if (typeof window !== "undefined") {
			const event = new MessageEvent("message", {
				data: message,
			})
			window.dispatchEvent(event)
		}
	}

	public updateConfig(config: Partial<WebSocketConfig>) {
		this.wsClient.disconnect()
		this.wsClient = new WebSocketClient({
			serverUrl: config.serverUrl || "",
			authToken: config.authToken || "",
			reconnectInterval: config.reconnectInterval || 5000,
			maxRetries: config.maxRetries || 5,
		})
		this.setupConnection()
	}
}
