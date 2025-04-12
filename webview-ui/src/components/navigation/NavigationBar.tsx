import { Link, useNavigate } from "react-router-dom"
import { PlusIcon, HistoryIcon, SettingsIcon } from "../icons"
import { vscode } from "../../utils/vscode"
import { useFirebase } from "../../context/FirebaseContext"
import { EncryptionStatus } from "../encryption/EncryptionStatus"

type Tab = "settings" | "history" | "mcp" | "prompts" | "chat"

type WebSocketState = "connecting" | "connected" | "disconnected" | "error"

type NavigationBarProps = {
	activeTab: Tab
	onTabChange: (tab: Tab) => void
	user: any
	webSocketState?: WebSocketState
}

export const NavigationBar = ({ activeTab, onTabChange, user, webSocketState }: NavigationBarProps) => {
	const { auth } = useFirebase()
	const isStandalone = typeof acquireVsCodeApi === "undefined" // Added check
	const navigate = useNavigate()

	return (
		<div className="flex items-center justify-between p-2 border-b border-vscode-panel-border bg-vscode-panel-background">
			<div className="flex space-x-2">
				<button
					className={`p-2 rounded hover:bg-vscode-button-secondaryHoverBackground ${activeTab === "chat" ? "text-vscode-button-foreground bg-vscode-button-secondaryBackground" : "text-vscode-foreground"}`}
					onClick={() => onTabChange("chat")}
					title="Chat">
					<PlusIcon className="w-5 h-5" />
				</button>

				<button
					className={`p-2 rounded hover:bg-vscode-button-secondaryHoverBackground ${activeTab === "prompts" ? "text-vscode-button-foreground bg-vscode-button-secondaryBackground" : "text-vscode-foreground"}`}
					onClick={() => onTabChange("prompts")}
					title="Prompts">
					<span className="text-sm">P</span>
				</button>

				<button
					className={`p-2 rounded hover:bg-vscode-button-secondaryHoverBackground ${activeTab === "mcp" ? "text-vscode-button-foreground bg-vscode-button-secondaryBackground" : "text-vscode-foreground"}`}
					onClick={() => onTabChange("mcp")}
					title="MCP">
					<span className="text-sm">M</span>
				</button>

				<button
					className={`p-2 rounded hover:bg-vscode-button-secondaryHoverBackground ${activeTab === "history" ? "text-vscode-button-foreground bg-vscode-button-secondaryBackground" : "text-vscode-foreground"}`}
					onClick={() => onTabChange("history")}
					title="History">
					<HistoryIcon className="w-5 h-5" />
				</button>
			</div>

			<div className="flex space-x-2 items-center">
				{" "}
				{/* Added items-center */}
				{/* Encryption Status */}
				{!isStandalone && <EncryptionStatus />}
				
				{/* Connect Button (Only in Extension) */}
				{!isStandalone && (
					<button
						className={`p-2 rounded ${
							webSocketState === "connected"
								? "bg-vscode-button-secondaryBackground text-vscode-button-foreground" // Style for connected
								: "hover:bg-vscode-button-secondaryHoverBackground text-vscode-foreground" // Default style
						}`}
						onClick={() => vscode.postMessage({ type: "connectWebSocket" })}
						title={
							webSocketState === "connected"
								? "Connected"
								: webSocketState === "connecting"
									? "Connecting..."
									: "Connect WebSocket" // Default/Disconnected/Error title
						}
						disabled={webSocketState === "connecting" || webSocketState === "connected"}>
						<span className="text-xs">
							{webSocketState === "connected"
								? "Connected" // Text when connected
								: webSocketState === "connecting"
									? "Connecting..." // Text when connecting
									: "Connect WS"}{" "}
							{/* Default/Disconnected/Error text */}
						</span>
					</button>
				)}
				<button
					className={`p-2 rounded hover:bg-vscode-button-secondaryHoverBackground ${activeTab === "settings" ? "text-vscode-button-foreground bg-vscode-button-secondaryBackground" : "text-vscode-foreground"}`}
					onClick={() => onTabChange("settings")}
					title="Settings">
					<SettingsIcon className="w-5 h-5" />
				</button>
				{user ? (
					<div className="relative group">
						<button className="flex items-center space-x-1 p-2 rounded hover:bg-vscode-button-secondaryHoverBackground">
							<span className="text-md text-vscode-descriptionForeground">{user.email}</span>
							<span className="codicon codicon-chevron-down text-xs"></span>
						</button>
						<div className="absolute right-0 mt-1 w-48 rounded-md shadow-lg bg-vscode-dropdown-background border border-vscode-dropdown-border hidden group-hover:block z-50">
							<div className="py-1">
								<button
									className="block w-full text-left px-4 py-2 text-sm text-vscode-foreground hover:bg-vscode-list-hoverBackground"
									onClick={() => auth.signOut()}>
									Sign Out
								</button>
							</div>
						</div>
					</div>
				) : (
					<button
						className="p-2 rounded hover:bg-vscode-button-secondaryHoverBackground text-vscode-foreground"
						onClick={async () => {
							if (isStandalone) {
								// Pass current path as redirect URL
								const currentUrl = new URL(window.location.href)
								navigate(`/login?redirect_url=${encodeURIComponent(currentUrl.toString())}`)
							} else {
								vscode.postMessage({
									type: "requestLogin",
								})
							}
						}}
						title="Login with Google">
						Login
						<div className="w-5 h-5" />
					</button>
				)}
				{/* Conditionally add the 'X' button in standalone mode */}
				{isStandalone && (
					<Link
						to="/"
						title="Back to Active Sessions"
						className="p-1 flex items-center justify-center text-lg text-vscode-foreground hover:bg-vscode-toolbar-hoverBackground rounded focus:outline-none focus:ring-2 focus:ring-vscode-focusBorder"
						aria-label="Back to Active Sessions">
						{/* Using Codicon 'close' */}
						<span className="codicon codicon-close"></span>
					</Link>
				)}
			</div>
		</div>
	)
}
