import { WsClient } from "../lib/ws-client"

declare global {
	interface Window {
		wsClient?: WsClient
		vscode?: {
			postMessage(message: any): void
		}
		acquireVsCodeApi?: () => {
			postMessage(message: any): void
		}
	}

	interface Navigator {
		userAgent: string
	}
}
