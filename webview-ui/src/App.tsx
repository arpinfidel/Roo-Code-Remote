import { useCallback, useEffect, useRef, useState } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionMessage } from "../../src/shared/ExtensionMessage"
import { NavigationBar } from "./components/navigation/NavigationBar"
import TranslationProvider from "./i18n/TranslationContext"

import { vscode } from "./utils/vscode"
import { useWs, WsProvider } from "./context/ws-context"
import { telemetryClient } from "./utils/TelemetryClient"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import ChatView from "./components/chat/ChatView"
import HistoryView from "./components/history/HistoryView"
import SettingsView, { SettingsViewRef } from "./components/settings/SettingsView"
import WelcomeView from "./components/welcome/WelcomeView"
import McpView from "./components/mcp/McpView"
import PromptsView from "./components/prompts/PromptsView"
import { HumanRelayDialog } from "./components/human-relay/HumanRelayDialog"

// Mock vscode API when not in VSCode
if (typeof acquireVsCodeApi === "undefined") {
	window.vscode = {
		postMessage: (msg: any) => console.log("Standalone mode:", msg),
	}
}

type Tab = "settings" | "history" | "mcp" | "prompts" | "chat"

const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	promptsButtonClicked: "prompts",
	mcpButtonClicked: "mcp",
	historyButtonClicked: "history",
	plusButtonClicked: "chat",
}

const App = () => {
	const { didHydrateState, showWelcome, shouldShowAnnouncement, telemetrySetting, telemetryKey, machineId } =
		useExtensionState()

	const [showAnnouncement, setShowAnnouncement] = useState(false)
	const [tab, setTab] = useState<Tab>("chat")

	const [humanRelayDialogState, setHumanRelayDialogState] = useState<{
		isOpen: boolean
		requestId: string
		promptText: string
	}>({
		isOpen: false,
		requestId: "",
		promptText: "",
	})

	const settingsRef = useRef<SettingsViewRef>(null)

	const switchTab = useCallback((newTab: Tab) => {
		if (settingsRef.current?.checkUnsaveChanges) {
			settingsRef.current.checkUnsaveChanges(() => setTab(newTab))
		} else {
			setTab(newTab)
		}
	}, [])

	const onMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if (message.type === "action" && message.action) {
				const newTab = tabsByMessageAction[message.action]

				if (newTab) {
					switchTab(newTab)
				}
			}

			if (message.type === "showHumanRelayDialog" && message.requestId && message.promptText) {
				const { requestId, promptText } = message
				setHumanRelayDialogState({ isOpen: true, requestId, promptText })
			}
		},
		[switchTab],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		if (shouldShowAnnouncement) {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement])

	useEffect(() => {
		if (didHydrateState) {
			telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, machineId)
		}
	}, [telemetrySetting, telemetryKey, machineId, didHydrateState])

	// Initialize connection based on environment
	const { connect, client } = useWs()
	useEffect(() => {
		if (typeof acquireVsCodeApi !== "undefined") {
			vscode.postMessage({ type: "webviewDidLaunch" })
		} else {
			const wsUrl = process.env.WS_URL || "ws://localhost:8080/ws"
			console.log(`Standalone mode, connecting to ${wsUrl}`)

			// get session_id from query param
			const urlParams = new URLSearchParams(window.location.search)
			const sessionId = urlParams.get("session_id")
			client.setClientType("webui")
			client.setSessionId(sessionId)
			client.setURL(wsUrl)

			vscode.setWsClient(client)

			connect(wsUrl)
				.then(() => console.log("WebSocket connection successful"))
				.catch((err) => console.error("WebSocket connection not successful:", err))
		}
	}, [connect, client])

	if (!didHydrateState) {
		return null
	}

	// Do not conditionally load ChatView, it's expensive and there's state we
	// don't want to lose (user input, disableInput, askResponse promise, etc.)
	return showWelcome ? (
		<WelcomeView />
	) : (
		<div className="flex flex-col h-screen">
			<NavigationBar activeTab={tab} onTabChange={switchTab} />
			<div className="flex-1 overflow-auto">
				{tab === "prompts" && <PromptsView onDone={() => switchTab("chat")} />}
				{tab === "mcp" && <McpView onDone={() => switchTab("chat")} />}
				{tab === "history" && <HistoryView onDone={() => switchTab("chat")} />}
				{tab === "settings" && <SettingsView ref={settingsRef} onDone={() => setTab("chat")} />}
				<ChatView
					isHidden={tab !== "chat"}
					showAnnouncement={showAnnouncement}
					hideAnnouncement={() => setShowAnnouncement(false)}
					showHistoryView={() => switchTab("history")}
				/>
			</div>
			<HumanRelayDialog
				isOpen={humanRelayDialogState.isOpen}
				requestId={humanRelayDialogState.requestId}
				promptText={humanRelayDialogState.promptText}
				onClose={() => setHumanRelayDialogState((prev) => ({ ...prev, isOpen: false }))}
				onSubmit={(requestId, text) => vscode.postMessage({ type: "humanRelayResponse", requestId, text })}
				onCancel={(requestId) => vscode.postMessage({ type: "humanRelayCancel", requestId })}
			/>
		</div>
	)
}

const queryClient = new QueryClient()

const AppWithProviders = () => (
	<ExtensionStateContextProvider>
		<TranslationProvider>
			<QueryClientProvider client={queryClient}>
				<WsProvider>
					<App />
				</WsProvider>
			</QueryClientProvider>
		</TranslationProvider>
	</ExtensionStateContextProvider>
)

export default AppWithProviders
