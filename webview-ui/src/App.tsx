import { useCallback, useEffect, useRef, useState } from "react"
import { User } from "firebase/auth"
import { FirebaseProvider, useFirebase } from "./context/FirebaseContext"
import { useAuthToken } from "./components/ui/hooks/useAuthToken"
import { Button } from "./components/ui/button" // For UI
import { Input } from "./components/ui/input" // For UI

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
// Remove old crypto utils import
// import {
// 	initializeSodium,
// 	generateKeyPair,
// 	calculateVerificationValue,
// 	calculateClientSharedSecret, // Needed for session key
// } from "./lib/cryptoUtils" // E2EE Crypto Utils
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
type WebSocketState = "connecting" | "connected" | "disconnected" | "error"

const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	promptsButtonClicked: "prompts",
	mcpButtonClicked: "mcp",
	historyButtonClicked: "history",
	plusButtonClicked: "chat",
}

// Use PairingState from WsClient (implicitly via event)
type PairingState = "unpaired" | "pairing" | "paired" | "error"

// Remove old local storage keys constants
// const WEBVIEW_PRIVATE_KEY_LS = "cline.e2ee.webviewPrivateKey"
// const EXTENSION_PUBLIC_KEY_LS = "cline.e2ee.extensionPublicKey"

const MainAppView: React.FC<{ user: any }> = ({ user }) => {
	// --- State ---
	const [tab, setTab] = useState<Tab>("chat")
	const [webSocketState, setWebSocketState] = useState<WebSocketState>("disconnected")
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

	// --- Refs ---
	const settingsRef = useRef<SettingsViewRef>(null)

	// --- Context ---
	const { shouldShowAnnouncement } = useExtensionState()
	const { connect, client } = useWs()
	const { token, getAuthHeaders } = useAuthToken()
	const [searchParams] = useSearchParams()

	// --- E2EE State (New) ---
	const [pairingState, setPairingState] = useState<PairingState>("unpaired") // Local state reflecting WsClient
	const [pairingCodeInput, setPairingCodeInput] = useState("")
	const [pairingError, setPairingError] = useState<string | null>(null)
	// isSodiumReady might still be useful if crypto ops are needed directly in UI, but WsClient handles most now.
	// const [isSodiumReady, setIsSodiumReady] = useState(false)
	// Remove old state: webviewKeys, extensionPublicKey, challengeVerificationValue, sessionSharedSecret
	const [isInitiatingPairing, setIsInitiatingPairing] = useState(false) // State for button disable
	// Removed duplicate state declaration

	// --- Callbacks ---
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
			console.log("Webview received message:", message) // Debug log

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

			// Handle WebSocket state updates
			if (message.type === "websocketState" && message.websocketState) {
				setWebSocketState(message.websocketState)
			}

			// Remove old E2EE message handling logic - WsClient handles this now
			// --- E2EE Message Handling ---
			// if (message.type === "pairingChallenge") { ... }
			// if (message.type === "pairingStatus") { ... }
			// --- E2EE Message Handling End ---

			// Remove old session key handling logic
			// --- E2EE Session Key Handling End ---
		},
		[switchTab], // Remove old E2EE state dependencies
	)

	// --- E2EE Pairing Handlers (New) ---
	const handleInitiatePairingClick = useCallback(() => {
		console.log("Initiate pairing button clicked.")
		setIsInitiatingPairing(true)
		setPairingError(null)
		// Send message to extension to start the process
		vscode.postMessage({ type: "initiatePairing" })
		// The extension will respond by generating a code and sending the 'start' message,
		// which will trigger the state change to 'pairing' via the WsClient listener.
		// Add a timeout in case the extension doesn't respond?
		setTimeout(() => setIsInitiatingPairing(false), 5000) // Re-enable button after 5s if no response
	}, [])

	const handleSubmitCodeClick = useCallback(async () => {
		if (!client) {
			setPairingError("WebSocket client not available.")
			return
		}
		if (pairingState !== "pairing") {
			console.warn("Attempted to submit code outside of pairing state.")
			return
		}
		if (pairingCodeInput.length !== 6) {
			setPairingError("Pairing code must be 6 digits.")
			return
		}

		setPairingError(null) // Clear previous errors
		console.log("Submitting pairing code:", pairingCodeInput)
		try {
			// WsClient handles the crypto and sending the 'exchange' message
			await client.submitPairingCode(pairingCodeInput)
			// State remains 'pairing' until 'complete' message is received from extension
			console.log("'exchange' message sent, waiting for 'complete' confirmation...")
			// Optionally add a 'verifying' visual state here if desired
		} catch (err) {
			console.error("Error submitting pairing code via WsClient:", err)
			setPairingError(`Failed to submit code: ${err instanceof Error ? err.message : String(err)}`)
			// WsClient might reset state on error, or we can do it here
			// setPairingState("error"); // Reflect error locally
		}
	}, [client, pairingState, pairingCodeInput])
	// Remove old handlers: handlePairClick, handleVerifyCodeClick, initiateSessionKeyExchange

	// --- Effects ---
	useEvent("message", onMessage) // Register message handler

	// Remove old Sodium init and key loading effects - WsClient handles this internally
	// useEffect(() => { initializeSodium()... }, [])
	// useEffect(() => { load keys from localStorage... }, [isSodiumReady])

	// Effect to listen to WsClient pairing events
	useEffect(() => {
		if (!client) return

		const handlePairingStatusChange = (event: Event) => {
			const newStatus = (event as CustomEvent).detail as PairingState
			console.log("WsClient pairing status changed:", newStatus)
			setPairingState(newStatus)
			setPairingError(null) // Clear error on status change
			if (newStatus !== "pairing") {
				setPairingCodeInput("") // Clear code input if not in pairing mode
			}
		}

		const handleE2eeError = (event: Event) => {
			const error = (event as CustomEvent).detail as Error
			console.error("WsClient E2EE Error:", error)
			setPairingError(error.message || "An unknown pairing error occurred.")
			setPairingState("error") // Set local state to error
		}

		client.on("pairing_status_changed", handlePairingStatusChange)
		client.on("e2ee_error", handleE2eeError)

		// Get initial state in case event was missed before listener attached
		// TODO: Add a method to WsClient to get current pairing state?
		// For now, rely on initial state set by initializeE2EE in WsClient constructor

		return () => {
			client.off("pairing_status_changed", handlePairingStatusChange)
			client.off("e2ee_error", handleE2eeError)
		}
	}, [client])

	// Announcement Effect
	useEffect(() => {
		if (shouldShowAnnouncement) {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement])

	// Standalone mode WebSocket connection
	useEffect(() => {
		if (typeof acquireVsCodeApi === "undefined") {
			const standaloneSessionId = searchParams.get("session_id")
			console.log("MainAppView Standalone Mode - Session ID:", standaloneSessionId)

			const wsUrl = process.env.WS_URL || "ws://localhost:8080/ws"
			console.log(`MainAppView Standalone mode, connecting to ${wsUrl}`)

			client.setClientType("webui")
			client.setSessionId(standaloneSessionId) // Set session ID from URL param
			client.setURL(wsUrl)

			// Set auth token if available
			if (token) {
				client.setAuthToken(token)
			} else {
				// If token isn't immediately available, get it from headers
				getAuthHeaders()
					.then((headers) => {
						const authToken = headers.Authorization?.split(" ")[1]
						if (authToken) {
							client.setAuthToken(authToken)
						}
					})
					.catch((err) => console.error("Error getting auth headers:", err))
			}

			// Ensure the mock vscode has the client reference and call setWsClient
			if (window.vscode && typeof (window.vscode as MockVscode).setWsClient === "function") {
				;(window.vscode as MockVscode).setWsClient!(client) // Use non-null assertion if sure it exists
			}

			connect(wsUrl)
				.then(() => console.log("MainAppView: WebSocket connection successful"))
				.catch((err) => console.error("MainAppView: WebSocket connection not successful:", err))
		}
	}, [searchParams, connect, client, token, getAuthHeaders])

	// --- Render ---
	return (
		<div className="flex flex-col h-screen">
			<NavigationBar activeTab={tab} onTabChange={switchTab} user={user} webSocketState={webSocketState} />
			<div className="flex-1 overflow-auto p-4"> {/* Added padding for pairing UI */}
				{/* E2EE Pairing UI */}
				{/* Updated E2EE Pairing UI */}
				<div className="mb-4 p-2 border rounded bg-secondary/10">
					<h3 className="text-lg font-semibold mb-2">End-to-End Encryption</h3>
					<p className="mb-2">
						Status: <span className="font-mono font-semibold">{pairingState}</span>
					</p>
					{pairingError && <p className="text-red-500 mb-2">Error: {pairingError}</p>}

					{/* Show pairing instructions/input only when pairing is active */}
					{pairingState === "pairing" && (
						<div className="flex flex-col gap-2">
							<p>Enter the 6-digit code displayed in VS Code:</p>
							<div className="flex items-center gap-2">
								<Input
									type="text"
									placeholder="Pairing Code"
									value={pairingCodeInput}
									onChange={(e) => setPairingCodeInput(e.target.value.replace(/[^0-9]/g, ""))} // Allow only digits
									maxLength={6}
									className="w-32"
									aria-label="Pairing Code Input"
								/>
								<Button onClick={handleSubmitCodeClick} disabled={pairingCodeInput.length !== 6}>
									Submit Code
								</Button>
							</div>
						</div>
					)}

					{/* Indicate paired status */}
					{pairingState === "paired" && <p className="text-green-500">Secure connection established.</p>}

					{/* Button to initiate pairing from Web UI */}
					{pairingState === "unpaired" && (
						<Button onClick={handleInitiatePairingClick} disabled={isInitiatingPairing}>
							{isInitiatingPairing ? "Initiating..." : "Pair with Extension"}
						</Button>
					)}

					{/* Show error state clearly */}
					{pairingState === "error" && (
						<Button onClick={handleInitiatePairingClick}>Retry Pairing</Button> // Allow retry from error state
					)}
				</div>
				{/* End E2EE Pairing UI */}

				{/* Original Tab Content */}
				{tab === "prompts" && <PromptsView onDone={() => switchTab("chat")} />}
				{tab === "mcp" && <McpView onDone={() => switchTab("chat")} />}
				{tab === "history" && <HistoryView onDone={() => switchTab("chat")} />}
				{tab === "settings" && <SettingsView ref={settingsRef} onDone={() => setTab("chat")} />}
				<ChatView
					isHidden={tab !== "chat"}
					showAnnouncement={showAnnouncement}
					hideAnnouncement={() => setShowAnnouncement(false)}
					showHistoryView={() => switchTab("history")}
					// Remove old E2EE props from ChatView for now
					// sessionSharedSecret={sessionSharedSecret}
					// isSodiumReady={isSodiumReady}
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
	) : isStandalone ? (
		<Routes>
			<Route
				path="/app"
				element={
					<ProtectedRoute>
						<MainAppView user={user} />
					</ProtectedRoute>
				}
			/>
			<Route
				path="/"
				element={
					<ProtectedRoute>
						<ActiveSessionsView />
					</ProtectedRoute>
				}
			/>
			<Route path="/login" element={<LoginView />} />
			{/* Redirect root path based on authentication status */}
			<Route path="/" element={<Navigate to="/login" replace />} />
			{/* Redirect unknown paths */}
			<Route path="*" element={<Navigate to={isStandalone ? "/login" : "/app"} replace />} />
		</Routes>
	) : (
		<MainAppView user={user} />
	)
	// <Navigate to="/app" replace />
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
