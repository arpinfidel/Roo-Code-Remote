import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider" // Import ClineProvider

export interface WebSocketConfig {
	serverUrl: string
	// authToken: string // Remove static auth token
	provider: ClineProvider // Add provider to get the token dynamically
	reconnectInterval: number
	maxRetries: number
	autoConnect?: boolean
	sessionId: string
	clientType: "webui" | "extension"
}

export type WebSocketMessageType =
	| "command"
	| "response"
	| "event"
	| "vscode-message"
	| "vscode-event"
	| "client-connected"
	// Server internal types (should probably be defined server-side too)
	| "connection-info"
	| "acknowledge"
	| "error"
	// E2EE specific types
	| "E2EE_PUBKEY"
	| "E2EE_CONFIRM"
export interface WebSocketMessage {
	id?: string // Make id optional for outgoing messages
	type: WebSocketMessageType
	action?: string
	payload?: {
		encrypted?: boolean;
		data?: string; // Base64 encoded ciphertext
		nonce?: string; // Base64 encoded nonce
	} | any; // Allow original payload structure if not encrypted or for non-E2EE messages
	status?: string
	event?: string
	data?: any
	error?: string
	clientType?: "webui" | "extension"
	peerPublicKey?: string; // Sender's public key (for E2EE decryption key lookup)
}

export interface RooCodeSettings {
	websocket?: WebSocketConfig
	allowedCommands?: string[]
	customStoragePath?: string
	vsCodeLmModelSelector?: {
		vendor?: string
		family?: string
	}
}
