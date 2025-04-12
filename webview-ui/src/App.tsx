import React, { useCallback, useEffect, useRef, useState } from "react"
import { User } from "firebase/auth"
import { FirebaseProvider, useFirebase } from "./context/FirebaseContext"
import { useAuthToken } from "./components/ui/hooks/useAuthToken"
// Import UI components for the modal
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./components/ui/dialog"
import { Input } from "./components/ui/input"
import { Button } from "./components/ui/button"

import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
	BrowserRouter,
	MemoryRouter,
	Navigate,
	Route,
	Routes,
	useSearchParams,
} from "react-router-dom"

import { ExtensionMessage } from "../../src/shared/ExtensionMessage"
import { NavigationBar } from "./components/navigation/NavigationBar"
import TranslationProvider from "./i18n/TranslationContext"

import { vscode } from "./utils/vscode"
import { useWs, WsProvider } from "./context/ws-context" // Ensure this path is correct
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
import { ProtectedRoute } from "./components/auth/ProtectedRoute"

// Define a type for the mock vscode API
type MockVscode = {
	postMessage: (msg: any) => void
	setState: (state: any) => void
	getState: () => any
	_wsClient?: any
	setWsClient?: (client: any) => void
}

// Mock vscode API when not in VSCode
if (typeof acquireVsCodeApi === "undefined") {
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
	} as MockVscode
}

type Tab = "settings" | "history" | "mcp" | "prompts" | "chat"
// WebSocketState type removed as we use the context status now

const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	promptsButtonClicked: "prompts",
	mcpButtonClicked: "mcp",
	historyButtonClicked: "history",
	plusButtonClicked: "chat",
}

// Main Application View Component
const MainAppView: React.FC<{ user: User | null }> = ({ user }) => {
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

	// State and functions from WebSocket context
	const { status: wsStatus, submitPairingCode, error: wsError, client: wsClient } = useWs() // Renamed client to wsClient for clarity
	const [pairingCode, setPairingCode] = useState("")
	const [isSubmittingCode, setIsSubmittingCode] = useState(false)
	const [pairingError, setPairingError] = useState<string | null>(null)

	// Tab switching logic
	const switchTab = useCallback((newTab: Tab) => {
		if (settingsRef.current?.checkUnsaveChanges) {
			settingsRef.current.checkUnsaveChanges(() => setTab(newTab))
		} else {
			setTab(newTab)
		}
	}, [])

	// Standalone mode connection logic
	const [searchParams] = useSearchParams()
	const { connect } = useWs() // connect function from context

	useEffect(() => {
		console.log("\n\n\n\n\nwsStatus:", wsStatus, "\n\n\n\n\n")
	}, [wsStatus])

	// Message handler from extension
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

			// Handle websocketState messages from the extension
			if (message.type === "websocketState" && message.websocketState) {
				console.log("App: Received websocketState message from extension:", message.websocketState);
				
				// Map extension websocketState to our connection actions
				const state = message.websocketState;
				
				// If the extension reports the WebSocket is connected but our local state is disconnected,
				// we should try to connect our local client to match the extension's state
				if (state === "connected" && wsStatus === "disconnected") {
					// Use a default URL or get it from configuration
					const wsUrl = process.env.WS_URL || "ws://localhost:8080/ws";
					console.log("App: Extension reports WS connected, connecting local client to", wsUrl);
					// Get the connect function from the same context we're using
					connect(wsUrl).catch(err => console.error("Failed to connect local client:", err));
				}
			}
		},
		[switchTab, wsStatus, connect],
	)
	useEvent("message", onMessage)

	// Announcement effect
	useEffect(() => {
		if (shouldShowAnnouncement) {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement])
	const { token, getAuthHeaders } = useAuthToken()

	useEffect(() => {
		if (typeof acquireVsCodeApi === "undefined") { // Standalone mode
			const standaloneSessionId = searchParams.get("session_id")
			console.log("MainAppView Standalone Mode - Session ID:", standaloneSessionId)

			const wsUrl = process.env.WS_URL || "ws://localhost:8080/ws"
			console.log(`MainAppView Standalone mode, connecting to ${wsUrl}`)

			// Configure the client instance obtained from context
			wsClient.setClientType("webui")
			wsClient.setSessionId(standaloneSessionId)
			wsClient.setURL(wsUrl)

			// Set auth token (async handling)
			const setAuth = async () => {
				let currentToken = token;
				if (!currentToken) {
					const headers = await getAuthHeaders();
					currentToken = headers.Authorization?.split(" ")[1] ?? null;
				}
				if (currentToken) {
					wsClient.setAuthToken(currentToken);
				}
				// Connect after potentially setting the token
				connect(wsUrl)
					.then(() => console.log("MainAppView: WebSocket connection initiated"))
					.catch((err) => console.error("MainAppView: WebSocket connection initiation failed:", err))
			};
			setAuth();


			// Set client on mock vscode if available
			if (window.vscode && typeof (window.vscode as MockVscode).setWsClient === "function") {
				;(window.vscode as MockVscode).setWsClient!(wsClient)
			}
		}
	}, [searchParams, connect, wsClient, token, getAuthHeaders]) // Dependencies updated

	// Pairing code submission handler
	const handlePairingSubmit = useCallback(async () => {
		if (pairingCode.length !== 6) {
			setPairingError("Please enter a 6-digit code.");
			return;
		}
		setIsSubmittingCode(true);
		setPairingError(null);
		try {
			await submitPairingCode(pairingCode);
			// Success: Status change will close the modal via context listener
			setPairingCode(""); // Clear input
		} catch (err) {
			console.error("Pairing code submission failed:", err);
			setPairingError(err instanceof Error ? err.message : "An unknown error occurred during pairing.");
		} finally {
			setIsSubmittingCode(false);
		}
	}, [pairingCode, submitPairingCode]);

	return (
		<div className="flex flex-col h-screen">
			<NavigationBar activeTab={tab} onTabChange={switchTab} user={user} webSocketState={wsStatus === "pairing_required" ? "connecting" : wsStatus} />
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

			{/* Pairing Code Modal */}
			<Dialog open={wsStatus === "pairing_required"} onOpenChange={(open) => !open && setPairingError(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Enter Pairing Code</DialogTitle>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<p className="text-sm text-muted-foreground">
							Enter the 6-digit code displayed in your VS Code editor to establish a secure connection.
						</p>
						<Input
							type="text"
							value={pairingCode}
							onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
							maxLength={6}
							placeholder="123456"
							disabled={isSubmittingCode}
							onKeyDown={(e) => e.key === 'Enter' && handlePairingSubmit()} // Submit on Enter
						/>
						{pairingError && <p className="text-sm text-destructive">{pairingError}</p>}
						{wsStatus === "error" && wsError && !pairingError && <p className="text-sm text-destructive">Connection Error: {wsError.message}</p>}
					</div>
					<DialogFooter>
						<Button
							onClick={handlePairingSubmit}
							disabled={isSubmittingCode || pairingCode.length !== 6}
						>
							{isSubmittingCode ? "Verifying..." : "Submit Code"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

// App Component (Handles Routing and Welcome Screen)
const App = () => {
	const [user, setUser] = useState<User | null>(null)
	const { didHydrateState, showWelcome, telemetrySetting, telemetryKey, machineId } = useExtensionState()

	// Telemetry initialization
	useEffect(() => {
		if (didHydrateState) {
			telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, machineId)
		}
	}, [telemetrySetting, telemetryKey, machineId, didHydrateState])

	// Firebase auth state listener
	const { auth } = useFirebase()
	useEffect(() => {
		const unsubscribe = auth.onAuthStateChanged((user) => {
			setUser(user)
		})
		return () => unsubscribe()
	}, [auth])

	// Initial setup effect (VSCode specific)
	useEffect(() => {
		if (typeof acquireVsCodeApi !== "undefined") {
			vscode.postMessage({ type: "webviewDidLaunch" })
		} else {
			console.log("App Component: Standalone mode detected.")
		}
	}, [])

	if (!didHydrateState) {
		return null // Wait for state hydration
	}

	const isStandalone = typeof acquireVsCodeApi === "undefined"

	// Render WelcomeView or the main application routes
	return showWelcome ? (
		<WelcomeView />
	) : isStandalone ? (
		<Routes>
			<Route path="/app" element={<ProtectedRoute><MainAppView user={user} /></ProtectedRoute>} />
			<Route path="/" element={<ProtectedRoute><ActiveSessionsView /></ProtectedRoute>} />
			<Route path="/login" element={<LoginView />} />
			{/* Redirect root based on auth - assumes ProtectedRoute handles redirect if not logged in */}
			<Route path="/" element={<Navigate to="/" replace />} />
			<Route path="*" element={<Navigate to={isStandalone ? "/" : "/app"} replace />} />
		</Routes>
	) : (
		// VSCode mode doesn't need explicit routing here if MemoryRouter starts at /app
		<MainAppView user={user} />
	)
}

const queryClient = new QueryClient()

// Component wrapping App with all necessary providers
const AppWithProviders = () => {
	const isStandalone = typeof acquireVsCodeApi === "undefined"
	const RouterComponent = isStandalone ? BrowserRouter : MemoryRouter
	const routerProps = isStandalone ? {} : { initialEntries: ["/app"] }

	return (
		<RouterComponent {...routerProps}>
			<ExtensionStateContextProvider>
				<TranslationProvider>
					<QueryClientProvider client={queryClient}>
						<WsProvider> {/* Use the modified WsProvider */}
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
