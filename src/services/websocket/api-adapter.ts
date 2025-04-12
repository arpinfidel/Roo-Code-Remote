import { v4 as uuidv4 } from "uuid"
import { EncryptedWebSocketClient } from "../e2ee/encryptedClient" // Import the encrypted client
import { API } from "../../exports/api"
import { webviewMessageHandler } from "../../core/webview/webviewMessageHandler"
import { WebviewMessage } from "../../shared/WebviewMessage"
import * as vscode from "vscode"
import { WebSocketConfig, WebSocketMessage } from "./types"
import { ExtensionMessage } from "../../shared/ExtensionMessage"
// WebSocketClient is no longer directly used here, but EncryptedWebSocketClient uses its config type

export class WebSocketApiAdapter {
	private wsClient: EncryptedWebSocketClient // Use the encrypted client type
	private api: API
	private config: WebSocketConfig // Store config
	private context: vscode.ExtensionContext // Need context for SecretStorage

	constructor(api: API, config: WebSocketConfig, context: vscode.ExtensionContext) { // Add context parameter
		this.api = api
		this.config = config // Store config
		this.context = context // Store context

		// Instantiate the Encrypted Client
		const wsClient = new EncryptedWebSocketClient(config, context)
		this.wsClient = wsClient

		// Setup state change listeners for the Encrypted Client
		this.wsClient.on(EncryptedWebSocketClient.Events.Connecting, () => {
			this.api.getProvider()?.notifyWebSocketStateChange("connecting")
		})
		// Note: 'connected' from EncryptedClient means underlying WS is connected,
		// but E2EE might still be pairing. We might need a more granular state for the UI.
		// For now, map 'connected' and 'paired' E2EE state to 'connected' UI state.
		this.wsClient.on(EncryptedWebSocketClient.Events.Connected, () => {
			// Underlying connected, maybe show 'authenticating...' or similar?
			// Let's keep it simple for now and map to 'connected' once paired.
		})
		this.wsClient.on(EncryptedWebSocketClient.Events.Disconnected, () => {
			this.api.getProvider()?.notifyWebSocketStateChange("disconnected")
		})
		this.wsClient.on(EncryptedWebSocketClient.Events.Error, (error: Error) => {
			// Log the specific error
			console.error("WebSocket/E2EE Error:", error)
			vscode.window.showErrorMessage(`WebSocket connection error: ${error.message}`)
			this.api.getProvider()?.notifyWebSocketStateChange("error")
		})
		this.wsClient.on(EncryptedWebSocketClient.Events.E2EEStateChange, (newState) => {
			console.log("Adapter received E2EE state change:", newState)
			// Update UI state based on E2EE state
			switch (newState) {
				case 'paired':
					this.api.getProvider()?.notifyWebSocketStateChange("connected") // Consider 'paired' as fully connected
					break;
				case 'connecting':
				case 'checking_pairing':
				case 'requesting_pairing':
				case 'awaiting_peer_pubkey':
				case 'awaiting_pairing_code_entry':
				case 'awaiting_verification':
					this.api.getProvider()?.notifyWebSocketStateChange("connecting") // Show as connecting during pairing
					break;
				case 'pairing_failed':
					this.api.getProvider()?.notifyWebSocketStateChange("error")
					break;
				case 'disconnected':
					this.api.getProvider()?.notifyWebSocketStateChange("disconnected")
					break;
			}
		})
		// Handle pairing code display
		this.wsClient.on(EncryptedWebSocketClient.Events.PairingCodeGenerated, (code: string) => {
			vscode.window.showInformationMessage(`Enter this pairing code in the Web UI: ${code}`, { modal: true });
			// We could potentially also send this code to the sidebar webview if needed
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

		// Listen for decrypted messages from the Encrypted Client
		this.wsClient.on(EncryptedWebSocketClient.Events.Message, (message: WebSocketMessage) => {
			console.log("ws-client: received decrypted message", message)
			// Process the message as before (it's already decrypted)
			switch (message.type) {
				case "vscode-message":
					this.webviewCommand(message)
						.then((result) => {
							// Send response (will be encrypted by the wrapper)
							// ID is handled by the client, so we omit it here.
							this.wsClient.send({
								// id: message.id, // Remove original ID
								type: "response",
								status: "completed",
								payload: result,
							}) // No need for 'as WebSocketMessage' if types align
						})
						.catch((error) => {
							// Send error response (will be encrypted by the wrapper)
							// ID is handled by the client, so we omit it here.
							this.wsClient.send({
								// id: message.id, // Remove original ID
								type: "response",
								status: "error",
								error: error.message,
							})
						})
					break
				case "client-connected": // This might be redundant with E2EE pairing logic now
					console.log("Received 'client-connected' message.");
					// const provider = this.api.getProvider()
					// provider?.getStateToPostToWebview().then((state) => {
					// 	provider.emit("messageToWebview", { type: "state", state })
					// })
					break
				// Note: 'e2ee' type messages are handled internally by EncryptedWebSocketClient
			}
		})

		// Error listener is already set up above to handle EncryptedClient errors
	}

	public forwardMessageEvent(event: ExtensionMessage) {
		// Check E2EE state before attempting to send
		if (this.wsClient.getE2EEState() === 'paired') {
			// Send will automatically encrypt the payload
			this.wsClient.send({
				type: "vscode-event",
				// id is added by the client now
				payload: event,
			}).catch(error => {
				console.error("Error sending message via E2EE WebSocket:", error);
				// Optionally notify the user or handle the error
				vscode.window.showErrorMessage(`Failed to send message: ${error.message}`);
			});
		} else {
			// Log or queue the message if not paired? For now, just log.
			console.warn(`Attempted to forward message via WebSocket, but E2EE is not paired. State: ${this.wsClient.getE2EEState()}`, event);
			// Optionally queue messages here to send once paired state is reached.
		}
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

	public updateConfig(newConfig: WebSocketConfig) {
		// We need the context here too. Assume it doesn't change, or pass it again.
		console.log("Updating WebSocket config and reconnecting...");
		this.config = newConfig // Update stored config
		this.wsClient.disconnect() // Disconnect the old client

		// Create a new Encrypted Client with the new config
		this.wsClient = new EncryptedWebSocketClient(newConfig, this.context)

		// Re-setup listeners (or ensure the new client instance handles this)
		// For simplicity, let's assume the constructor handles listener setup.
		// If not, re-attach listeners here.
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
