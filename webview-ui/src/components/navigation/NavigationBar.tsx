import { Link } from "react-router-dom" // Added
import { PlusIcon, HistoryIcon, SettingsIcon, HelpIcon } from "../icons"
import { vscode } from "../../utils/vscode"

type Tab = "settings" | "history" | "mcp" | "prompts" | "chat"

type NavigationBarProps = {
	activeTab: Tab
	onTabChange: (tab: Tab) => void
}

export const NavigationBar = ({ activeTab, onTabChange }: NavigationBarProps) => {
	const isStandalone = typeof acquireVsCodeApi === "undefined" // Added check

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

			<div className="flex space-x-2">
				<button
					className="p-2 rounded hover:bg-vscode-button-secondaryHoverBackground text-vscode-foreground"
					onClick={() => vscode.postMessage({ type: "popoutButtonClicked" })}
					title="Popout">
					<span className="text-sm">↗</span>
				</button>

				<button
					className={`p-2 rounded hover:bg-vscode-button-secondaryHoverBackground ${activeTab === "settings" ? "text-vscode-button-foreground bg-vscode-button-secondaryBackground" : "text-vscode-foreground"}`}
					onClick={() => onTabChange("settings")}
					title="Settings">
					<SettingsIcon className="w-5 h-5" />
				</button>

				<button
					className="p-2 rounded hover:bg-vscode-button-secondaryHoverBackground text-vscode-foreground"
					onClick={() => vscode.postMessage({ type: "helpButtonClicked" })}
					title="Help">
					<HelpIcon className="w-5 h-5" />
				</button>

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
