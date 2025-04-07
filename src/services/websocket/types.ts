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
	| "pairing-request"
	| "pairing-response"
	| "pairing-complete"

export interface WebSocketMessage {
	id?: string // Make id optional for outgoing messages
	type: WebSocketMessageType
	action?: string
	payload?: any
	status?: string
	event?: string
	data?: any
	error?: string
	clientType?: "webui" | "extension"
	encrypted?: boolean // Flag indicating if payload is encrypted
	iv?: string // Initialization vector for AES-GCM
	keyId?: string // ID of encryption key used
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
