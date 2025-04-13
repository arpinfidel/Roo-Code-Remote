import { v4 as uuidv4 } from "uuid"
// import { WebSocketClient } from "./client" // Use Encrypted client instead
import { EncryptedWebSocketClient } from "../e2ee/encrypted-ws-client" // Import E2EE client
import { PairingState } from "../e2ee/pairing" // Import PairingState type
import { API } from "../../exports/api"
import { webviewMessageHandler } from "../../core/webview/webviewMessageHandler"
import { WebviewMessage } from "../../shared/WebviewMessage"
import * as vscode from "vscode"
import { WebSocketConfig, WebSocketMessage } from "./types"
import { ExtensionMessage } from "../../shared/ExtensionMessage"

export class WebSocketApiAdapter {
	private wsClient: EncryptedWebSocketClient // Use the encrypted client type
	private api: API
	private config: WebSocketConfig // Store config

	// Add context needed for E2EE client (SecretStorage)
	constructor(api: API, config: WebSocketConfig, context: vscode.ExtensionContext) {
		this.api = api
		this.config = config // Store config

		// Instantiate the Encrypted Client
		this.wsClient = new EncryptedWebSocketClient(
			{
				serverUrl: config.serverUrl || "",
				provider: config.provider, // Pass provider for Firebase token
				reconnectInterval: config.reconnectInterval || 5000,
				maxRetries: config.maxRetries || 5,
				clientType: "extension",
				sessionId: config.sessionId,
			},
			context, // Pass context for E2EE key storage
		)

		// Initialize the E2EE client (loads/generates keys)
		this.wsClient.initialize().then(() => {
			console.log("EncryptedWebSocketClient initialized.");
			// Now setup connection logic based on client type
			if (this.config.clientType === "webui") {
				// This case shouldn't happen if adapter is created in extension.ts
				console.warn("WebSocketApiAdapter created with clientType 'webui' in extension context?");
				// this.setupConnection();
			} else {
				console.log("WebSocket connection deferred for manual initiation (extension mode).");
				// Connection will be initiated by connectManually or other logic
			}
		}).catch(err => {
			console.error("Failed to initialize EncryptedWebSocketClient:", err);
			vscode.window.showErrorMessage("Failed to initialize E2EE WebSocket client.");
		});


		// Setup listeners after initialization completes
		this.wsClient.initialize().then(() => {
			console.log("EncryptedWebSocketClient initialized.");
			this.setupEventForwarding(); // Call the extracted method
			// Now setup connection logic based on client type
			if (this.config.clientType === "webui") {
				// This case shouldn't happen if adapter is created in extension.ts
				console.warn("WebSocketApiAdapter created with clientType 'webui' in extension context?");
				// this.setupConnection();
			} else {
				console.log("WebSocket connection deferred for manual initiation (extension mode).");
				// Connection will be initiated by connectManually or other logic
			}
		}).catch(err => {
			console.error("Failed to initialize EncryptedWebSocketClient:", err);
			vscode.window.showErrorMessage("Failed to initialize E2EE WebSocket client.");
		});
	} // End of constructor

	// Extracted method for setting up event listeners/forwarders
	private setupEventForwarding(): void {
		// Setup state change listeners (forwarding from Encrypted Client)
		this.wsClient.on("connecting", () => {
			this.api.getProvider()?.notifyWebSocketStateChange("connecting")
		})
		this.wsClient.on("connected", () => {
			this.api.getProvider()?.notifyWebSocketStateChange("connected")
		})
		this.wsClient.on("disconnected", () => {
			this.api.getProvider()?.notifyWebSocketStateChange("disconnected")
		})
		this.wsClient.on("error", (err) => { // Forward error object
			this.api.getProvider()?.notifyWebSocketStateChange("error")
			// Optionally log or show the specific error here too
			console.error("WebSocket client error:", err);
		})
		// Add listeners for E2EE events
		this.wsClient.on("pairing-state-change", (state: PairingState) => {
			this.api.getProvider()?.notifyPairingStateChange(state)
		})
		this.wsClient.on("pairing-code", (code: string) => {
			this.api.getProvider()?.notifyPairingCode(code)
		})
		this.wsClient.on("paired", (peerKey: string) => {
			this.api.getProvider()?.notifyPaired(peerKey)
		})
		 this.wsClient.on("unpaired", () => {
			this.api.getProvider()?.notifyUnpaired()
		})

		// Add listener for incoming application messages (after decryption)
		this.wsClient.on("message", (message: WebSocketMessage) => {
			this.handleIncomingWsMessage(message);
		});
	}
// Remove extra closing brace here

	// Renamed from setupConnection to avoid confusion, now handles incoming messages
	private handleIncomingWsMessage(message: WebSocketMessage) {
		console.log("ws-adapter: received message", message.type, message.id);
		switch (message.type) {
			case "vscode-message":
				this.webviewCommand(message)
					.then((result) => {
						// Send response back via encrypted client (ID is added by the client)
						this.wsClient.send({
							// id: message.id, // Remove original ID
							type: "response",
							status: "completed",
							payload: result,
						}).catch(err => console.error("Failed to send WS response:", err));
					})
					.catch((error: Error) => { // Add type to error
						this.wsClient.send({
							// id: message.id, // Remove original ID
							type: "response",
							status: "error",
							error: error.message,
						}).catch(err => console.error("Failed to send WS error response:", err));
					})
				break
			case "client-connected": // Handle new client connecting to session
				const provider = this.api.getProvider()
				provider?.getStateToPostToWebview().then((state) => {
					// Post full state to webview when a remote client connects
					provider?.emit("messageToWebview", { type: "state", state })
				})
				break
			// Handle other message types if needed
			case "acknowledge":
			case "connection-info":
				// Usually just logged or ignored client-side
				break;
			default:
				console.warn("Received unhandled WebSocket message type:", message.type);
		}
	}

	// This now uses the encrypted client's send method, which handles encryption
	public forwardMessageEvent(event: ExtensionMessage) {
		// Construct the message payload as expected by the receiving end
		const messagePayload = {
			type: event.type, // e.g., 'state', 'progress', 'completion'
			// Include relevant data based on event type
			...(event.type === 'state' && { state: event.state }),
			// Removed invalid 'progress' check
			// Add other valid ExtensionMessage types if they need specific payload structuring
		};

		this.wsClient.send({
			type: "vscode-event", // Outer message type
			payload: messagePayload, // The actual event data
		}).catch(err => {
			console.error("Failed to forward vscode-event via WebSocket:", err);
			// Optionally notify user or log telemetry
		});
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

	// updateConfig needs to handle the Encrypted Client and context
	public updateConfig(config: WebSocketConfig, context: vscode.ExtensionContext) {
		this.config = config // Update stored config
		this.wsClient.disconnect() // Disconnect old client

		// Re-instantiate the Encrypted Client
		this.wsClient = new EncryptedWebSocketClient(
			{
				serverUrl: config.serverUrl || "",
				provider: config.provider,
				reconnectInterval: config.reconnectInterval || 5000,
				maxRetries: config.maxRetries || 5,
				clientType: "extension",
				sessionId: config.sessionId,
			},
			context, // Pass context
		)

		// Re-initialize E2EE and setup connection logic
		this.wsClient.initialize().then(() => {
			console.log("EncryptedWebSocketClient re-initialized after config update.");
			if (this.config.clientType === "webui") {
				// This case remains unlikely in extension context
				// this.setupConnection();
			} else {
				console.log("WebSocket connection deferred after config update (extension mode).");
			}
		}).catch(err => {
			console.error("Failed to re-initialize EncryptedWebSocketClient after config update:", err);
			vscode.window.showErrorMessage("Failed to re-initialize E2EE WebSocket client after config update.");
		});

		// Re-attach listeners (important!) - Note: This assumes the old listeners are garbage collected.
		// Consider a more robust listener management if needed.
		this.setupEventForwarding(); // Re-setup forwarding for the new client instance
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
		// setupConnection is now part of initialize/connectManually
		this.wsClient.connect().then(() => {
			vscode.window.showInformationMessage(`WebSocket connection successful`)
		}).catch((err) => {
			vscode.window.showErrorMessage(`WebSocket connection unsuccessful: ${err.message}`)
		});
	}
	// --- E2EE Pairing Control Methods --- (Now correctly inside the class)

	public initiatePairing() {
		this.wsClient.initiatePairing().catch((err: Error) => { // Add type to err
			console.error("Error initiating pairing:", err);
			vscode.window.showErrorMessage(`Failed to initiate pairing process: ${err.message}`);
		});
	}

	public confirmPairing() {
		this.wsClient.confirmPairing().catch((err: Error) => { // Add type to err
			console.error("Error confirming pairing:", err);
			vscode.window.showErrorMessage(`Failed to confirm pairing: ${err.message}`);
		});
	}

	// Optional: Method to reset/unpair
	public resetPairing() {
		// This might involve more than just calling the client,
		// e.g., clearing related state in the provider.
		// For now, just call the client's reset.
		// this.wsClient.resetPairing(); // Assuming EncryptedWsClient has resetPairing
		console.warn("WebSocketApiAdapter.resetPairing() called - ensure EncryptedWsClient has corresponding method if needed.");
	}
} // End of class WebSocketApiAdapter
