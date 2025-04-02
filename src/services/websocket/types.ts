import * as vscode from "vscode"

export interface WebSocketConfig {
	serverUrl: string
	authToken: string
	reconnectInterval: number
	maxRetries: number
	autoConnect?: boolean
}

export type WebSocketMessageType =
	| "command"
	| "response"
	| "event"
	| "client-identify"
	| "vscode-message"
	| "vscode-event"

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
