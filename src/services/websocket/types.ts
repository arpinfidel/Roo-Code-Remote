import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider" // Import ClineProvider
import { EncryptedPayload } from "./crypto" // Import EncryptedPayload

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
	| "pairing" // Generic type for pairing messages

// Define specific pairing actions
export type PairingAction =
	| "start" // Extension -> WebUI: Initiate pairing, send pubKey
	| "exchange" // WebUI -> Extension: Respond with pubKey and verification hash
	| "complete" // Extension -> WebUI: Confirm successful pairing
	| "error" // Either -> Other: Indicate pairing failure

export interface WebSocketMessage {
	id?: string // Make id optional for outgoing messages
	type: WebSocketMessageType
	action?: string | PairingAction // Allow specific pairing actions
	payload?: any // Keep generic payload for non-pairing messages
	status?: string
	event?: string
	data?: any // Keep for potential other uses
	error?: string // General error reporting
	clientType?: "webui" | "extension"
	encryptedPayload?: EncryptedPayload // Add optional encrypted payload field

	// Specific payloads for pairing messages (add type safety)
	pairingPayload?: PairingStartPayload | PairingExchangePayload | PairingErrorPayload
}

// --- Pairing Message Payloads ---

// Action: 'start' (Extension -> WebUI)
export interface PairingStartPayload {
	extensionPublicKey: string // base64 encoded public key
}

// Action: 'exchange' (WebUI -> Extension)
export interface PairingExchangePayload {
	webuiPublicKey: string // base64 encoded public key
	verificationHash: string // base64 encoded hash(extPubKey + webPubKey + code)
}

// Action: 'complete' (Extension -> WebUI)
// No specific payload needed, the action itself is the confirmation

// Action: 'error' (Either -> Other)
export interface PairingErrorPayload {
	reason: "hash_mismatch" | "timeout" | "invalid_code" | "internal_error" | "already_paired" | string // Error reason
	message?: string // Optional detailed error message
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
