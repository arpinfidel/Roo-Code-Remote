import { useCallback, useEffect, useRef, useState } from "react"
import { User } from "firebase/auth"
import { FirebaseProvider, useFirebase } from "./context/FirebaseContext"

import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
	BrowserRouter,
	MemoryRouter,
	Navigate,
	Route,
	Routes,
	useSearchParams, // Added
} from "react-router-dom" // Added

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
import ActiveSessionsView from "./components/sessions/ActiveSessionsView"
import { LoginView } from "./components/login/LoginView"

// Define a type for the mock vscode API
type MockVscode = {
	postMessage: (msg: any) => void
	setState: (state: any) => void // Add other methods if needed by the app
	getState: () => any
	_wsClient?: any // Optional property to hold the client
	setWsClient?: (client: any) => void // Optional method
}

// Mock vscode API when not in VSCode
if (typeof acquireVsCodeApi === "undefined") {
	// Assign the mock object with the defined type
	window.vscode = {
		postMessage: (msg: any) => console.log("Standalone mode:", msg),
		setState: (state: any) => console.log("Mock vscode: setState", state),
		getState: () => {
			console.log("Mock vscode: getState")
			return {}
		},
		setWsClient: (client: any) => {
			;(window.vscode as MockVscode)._wsClient = client
			console.log("Mock vscode: WebSocket client set")
		},
	} as MockVscode // Type assertion
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

const MainAppView: React.FC<{ user: any }> = ({ user }) => {
	const [tab, setTab] = useState<Tab>("chat")
	const [showAnnouncement, setShowAnnouncement] = useState(false)
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

	const { shouldShowAnnouncement } = useExtensionState()

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

			// Handle tab switching messages
			if (message.type === "action" && message.action) {
				const newTab = tabsByMessageAction[message.action]
				if (newTab) {
					switchTab(newTab)
				}
			}

			// Handle human relay dialog messages
			if (message.type === "showHumanRelayDialog" && message.requestId && message.promptText) {
				const { requestId, promptText } = message
				setHumanRelayDialogState({ isOpen: true, requestId, promptText })
			}
		},
		[switchTab],
	)
	useEvent("message", onMessage) // Register message handler here

	// Moved announcement effect from App
	useEffect(() => {
		if (shouldShowAnnouncement) {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement])

	// Standalone mode: Read session_id and potentially connect
	const [searchParams] = useSearchParams()
	const { connect, client } = useWs() // Get WS context here

	useEffect(() => {
		// This effect runs specifically within the MainAppView context
		if (typeof acquireVsCodeApi === "undefined") {
			const standaloneSessionId = searchParams.get("session_id")
			console.log("MainAppView Standalone Mode - Session ID:", standaloneSessionId)

			const wsUrl = process.env.WS_URL || "ws://localhost:8080/ws"
			console.log(`MainAppView Standalone mode, connecting to ${wsUrl}`)

			client.setClientType("webui")
			client.setSessionId(standaloneSessionId) // Set session ID from URL param
			client.setURL(wsUrl)

			// Ensure the mock vscode has the client reference and call setWsClient
			if (window.vscode && typeof (window.vscode as MockVscode).setWsClient === "function") {
				;(window.vscode as MockVscode).setWsClient!(client) // Use non-null assertion if sure it exists
			}

			connect(wsUrl)
				.then(() => console.log("MainAppView: WebSocket connection successful"))
				.catch((err) => console.error("MainAppView: WebSocket connection not successful:", err))
		}
	}, [searchParams, connect, client]) // Depend on searchParams, connect, client

	// The original return statement when showWelcome is false
	return (
		<div className="flex flex-col h-screen">
			<NavigationBar activeTab={tab} onTabChange={switchTab} user={user} />
			<div className="flex-1 overflow-auto">
				{/* Render components based on internal tab state */}
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

const App = () => {
	const [user, setUser] = useState<User | null>(null)
	const { didHydrateState, showWelcome, telemetrySetting, telemetryKey, machineId } = useExtensionState()

	useEffect(() => {
		if (didHydrateState) {
			telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, machineId)
		}
	}, [telemetrySetting, telemetryKey, machineId, didHydrateState])

	const { auth } = useFirebase()

	useEffect(() => {
		const unsubscribe = auth.onAuthStateChanged((user) => {
			setUser(user)
		})
		return () => unsubscribe()
	}, [auth])

	// Initial setup effect (only VSCode specific logic remains here)
	useEffect(() => {
		if (typeof acquireVsCodeApi !== "undefined") {
			// Let extension handle connection/state
			vscode.postMessage({ type: "webviewDidLaunch" })
		} else {
			// Standalone connection logic moved to MainAppView
			console.log("App Component: Standalone mode detected.")
		}
	}, []) // Runs once on mount

	if (!didHydrateState) {
		return null
	}

	const isStandalone = typeof acquireVsCodeApi === "undefined"

	// Show WelcomeView if needed, otherwise render the Routes
	return showWelcome ? (
		<WelcomeView />
	) : (
		<Routes>
			<Route path="/app" element={<MainAppView user={user} />} />
			{/* Conditionally render ActiveSessionsView only in standalone mode */}
			{isStandalone && <Route path="/" element={<ActiveSessionsView />} />}
			<Route path="/login" element={<LoginView />} />
			{/* Redirect unknown paths */}
			<Route path="*" element={<Navigate to={isStandalone ? "/" : "/app"} replace />} />
		</Routes>
	)
}

const queryClient = new QueryClient()

const AppWithProviders = () => {
	// Determine Router based on environment
	const isStandalone = typeof acquireVsCodeApi === "undefined"
	const RouterComponent = isStandalone ? BrowserRouter : MemoryRouter
	// Set initial route for MemoryRouter (VSCode extension)
	const routerProps = isStandalone ? {} : { initialEntries: ["/app"] }

	return (
		// Wrap with the chosen router
		<RouterComponent {...routerProps}>
			<ExtensionStateContextProvider>
				<TranslationProvider>
					<QueryClientProvider client={queryClient}>
						<WsProvider>
							<FirebaseProvider>
								<App />
							</FirebaseProvider>
						</WsProvider>
					</QueryClientProvider>
				</TranslationProvider>
			</ExtensionStateContextProvider>
		</RouterComponent>
	)
}

export default AppWithProviders
