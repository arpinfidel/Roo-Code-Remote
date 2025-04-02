import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { WsClient } from "./lib/ws-client"

import "./index.css"
import App from "./App"

// Only load VSCode icons when running in VSCode environment
if (typeof acquireVsCodeApi !== "undefined") {
	import("../../node_modules/@vscode/codicons/dist/codicon.css")
} else {
	// Initialize WebSocket client in standalone mode
	window.wsClient = new WsClient()
	window.wsClient.connect("ws://localhost:8080").catch(console.error)
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
