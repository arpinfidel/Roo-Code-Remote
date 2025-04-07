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
import {
	initializeSodium,
	generateKeyPair,
	calculateVerificationValue,
	calculateClientSharedSecret, // Needed for session key
} from "./lib/cryptoUtils" // E2EE Crypto Utils
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

type PairingStatus = "unpaired" | "pairing" | "awaitingCode" | "verifying" | "paired" | "error"
type KeyPairState = { publicKey: string | null; privateKey: string | null }

// Local storage keys
const WEBVIEW_PRIVATE_KEY_LS = "cline.e2ee.webviewPrivateKey"
const EXTENSION_PUBLIC_KEY_LS = "cline.e2ee.extensionPublicKey"

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

	// --- E2EE State ---
	const [pairingStatus, setPairingStatus] = useState<PairingStatus>("unpaired")
	const [webviewKeys, setWebviewKeys] = useState<KeyPairState>({ publicKey: null, privateKey: null })
	const [extensionPublicKey, setExtensionPublicKey] = useState<string | null>(null)
	const [pairingCodeInput, setPairingCodeInput] = useState("")
	const [challengeVerificationValue, setChallengeVerificationValue] = useState<string | null>(null)
	const [pairingError, setPairingError] = useState<string | null>(null)
	const [isSodiumReady, setIsSodiumReady] = useState(false)
	const [sessionSharedSecret, setSessionSharedSecret] = useState<string | null>(null) // E2EE Session Key
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

			// --- E2EE Message Handling ---
			if (message.type === "pairingChallenge") {
				console.log("Received pairing challenge from extension.")
				if (pairingStatus === "pairing") {
					if (message.extensionPublicKey && message.verificationValue) {
						setExtensionPublicKey(message.extensionPublicKey)
						setChallengeVerificationValue(message.verificationValue)
						setPairingStatus("awaitingCode")
						setPairingError(null) // Clear previous errors
						console.log("Stored challenge values, awaiting user code input.")
					} else {
						console.error("Invalid pairing challenge received:", message)
						setPairingError("Invalid pairing challenge received from extension.")
						setPairingStatus("error")
					}
				} else {
					console.warn("Received pairing challenge but not in 'pairing' state.")
				}
			}

			if (message.type === "pairingStatus") {
				if (message.status === "paired") {
					console.log("Received confirmation: Pairing successful.")
					setPairingStatus("paired")
					setPairingError(null)
					// Keys should already be stored in localStorage by handleVerifyCodeClick
					initiateSessionKeyExchange() // Initiate exchange after confirmation
					// TODO: Initiate session key exchange here
				} else {
					// Handle other potential statuses if needed (e.g., error from extension)
					console.error("Received non-paired status:", message.status)
					setPairingError(`Pairing failed on extension side: ${message.status || "Unknown error"}`)
					setPairingStatus("error")
				}
			}
			// --- E2EE Message Handling End ---

			// --- E2EE Session Key Handling ---
			if (message.type === "sessionAck") {
				console.log("Received sessionAck from extension.")
				if (pairingStatus === "paired" && webviewKeys.privateKey && message.extensionPublicKey) {
					calculateClientSharedSecret(
						webviewKeys.privateKey,
						webviewKeys.publicKey!, // Should exist if private key exists
						message.extensionPublicKey,
					)
						.then((secret) => {
							console.log("Session shared secret calculated.")
							setSessionSharedSecret(secret)
							// TODO: Now we can start encrypting messages
						})
						.catch((err) => {
							console.error("Failed to calculate session shared secret:", err)
							setPairingError("Failed to establish secure session.")
							setPairingStatus("error") // Revert to error state if session fails
							setSessionSharedSecret(null)
						})
				} else {
					console.warn("Received sessionAck but not in correct state or missing keys.")
				}
			}
			// --- E2EE Session Key Handling End ---
		},
		[switchTab, pairingStatus, webviewKeys.privateKey, webviewKeys.publicKey], // Add key dependencies
	)

	// --- E2EE Pairing Handlers ---
	const handlePairClick = useCallback(async () => {
		if (!isSodiumReady) {
			setPairingError("Encryption library not ready.")
			setPairingStatus("error")
			return
		}
		setPairingStatus("pairing")
		setPairingError(null)
		try {
			console.log("Generating webview key pair...")
			const keys = await generateKeyPair()
			setWebviewKeys(keys)
			localStorage.setItem(WEBVIEW_PRIVATE_KEY_LS, keys.privateKey) // Store private key
			console.log("Webview keys generated and private key stored.")
			vscode.postMessage({ type: "pairingRequest", text: keys.publicKey })
			console.log("Sent pairing request to extension.")
		} catch (err) {
			console.error("Error during key generation or pairing request:", err)
			setPairingError(`Failed to initiate pairing: ${err instanceof Error ? err.message : String(err)}`)
			setPairingStatus("error")
			setWebviewKeys({ publicKey: null, privateKey: null }) // Clear keys on error
			localStorage.removeItem(WEBVIEW_PRIVATE_KEY_LS) // Remove potentially stored key
		}
	}, [isSodiumReady])

	const handleVerifyCodeClick = useCallback(async () => {
		if (!isSodiumReady) {
			setPairingError("Encryption library not ready.")
			setPairingStatus("error")
			return
		}
		if (!webviewKeys.publicKey || !extensionPublicKey || !challengeVerificationValue) {
			setPairingError("Missing necessary information for verification.")
			setPairingStatus("error") // Or back to 'unpaired'? Error seems more appropriate.
			return
		}

		setPairingStatus("verifying")
		setPairingError(null)

		try {
			console.log("Calculating verification value...")
			const calculatedValue = await calculateVerificationValue(
				webviewKeys.publicKey,
				extensionPublicKey,
				pairingCodeInput,
			)
			console.log("Calculated:", calculatedValue, "Expected:", challengeVerificationValue)

			if (calculatedValue === challengeVerificationValue) {
				console.log("Verification successful!")
				// Store extension public key permanently
				localStorage.setItem(EXTENSION_PUBLIC_KEY_LS, extensionPublicKey)
				// Send success message to extension
				vscode.postMessage({ type: "pairingSuccess" })
				// Update state - extension will confirm with pairingStatus message
				// setPairingStatus("paired") // Let extension confirm via message
				setPairingCodeInput("")
				setChallengeVerificationValue(null)
				console.log("Stored extension public key and sent success message.")
			} else {
				console.warn("Verification failed: Codes do not match.")
				setPairingError("Invalid pairing code. Please try again.")
				setPairingStatus("awaitingCode") // Allow retry
				setPairingCodeInput("") // Clear input for retry
			}
		} catch (err) {
			console.error("Error during verification:", err)
			setPairingError(`Verification failed: ${err instanceof Error ? err.message : String(err)}`)
			setPairingStatus("error") // Or back to 'awaitingCode'? Error seems safer.
		}
	}, [
		isSodiumReady,
		webviewKeys.publicKey,
		extensionPublicKey,
		pairingCodeInput,
		challengeVerificationValue,
	])

	// --- E2EE Session Key Exchange ---
	const initiateSessionKeyExchange = useCallback(async () => {
		if (pairingStatus !== "paired" || !webviewKeys.publicKey || !extensionPublicKey || !isSodiumReady) {
			console.warn("Cannot initiate session key exchange: Not paired or keys/sodium not ready.")
			return
		}
		console.log("Initiating session key exchange...")
		// In this simple model, we just send the long-term public key again.
		// More complex protocols might use ephemeral keys for the exchange itself.
		vscode.postMessage({ type: "sessionHello", text: webviewKeys.publicKey })
	}, [pairingStatus, webviewKeys.publicKey, extensionPublicKey, isSodiumReady])
	// --- E2EE Session Key Exchange End ---

	// --- Effects ---
	useEvent("message", onMessage) // Register message handler

	// Initialize Sodium
	useEffect(() => {
		initializeSodium()
			.then(() => {
				console.log("Sodium initialized in MainAppView.")
				setIsSodiumReady(true)
			})
			.catch((err) => {
				console.error("Failed to initialize Sodium:", err)
				setPairingError("Failed to initialize encryption library.")
				setPairingStatus("error")
			})
	}, [])

	// Load E2EE keys from local storage on mount if Sodium is ready
	useEffect(() => {
		if (!isSodiumReady) return

		console.log("Checking for existing E2EE keys in localStorage...")
		const storedPrivateKey = localStorage.getItem(WEBVIEW_PRIVATE_KEY_LS)
		const storedExtensionPublicKey = localStorage.getItem(EXTENSION_PUBLIC_KEY_LS)

		if (storedPrivateKey && storedExtensionPublicKey) {
			console.log("Found existing keys. Setting state to 'paired'.")
			// TODO: Validate keys?
			setWebviewKeys((prev) => ({ ...prev, privateKey: storedPrivateKey }))
			setExtensionPublicKey(storedExtensionPublicKey)
			setPairingStatus("paired")
			initiateSessionKeyExchange() // Initiate exchange when keys are loaded
		} else {
			console.log("No existing keys found or keys incomplete. Status remains 'unpaired'.")
			setPairingStatus("unpaired") // Ensure status is unpaired if keys aren't found
		}
	}, [isSodiumReady]) // Run when sodium is ready

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
				getAuthHeaders().then((headers) => {
					const authToken = headers.Authorization?.split(" ")[1]
					if (authToken) {
						client.setAuthToken(authToken)
					}
				})
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
				<div className="mb-4 p-2 border rounded bg-secondary/10">
					<h3 className="text-lg font-semibold mb-2">End-to-End Encryption Status</h3>
					<p className="mb-2">Status: <span className="font-mono">{pairingStatus}</span></p>
					{pairingError && <p className="text-red-500 mb-2">Error: {pairingError}</p>}

					{pairingStatus === "unpaired" && (
						<Button onClick={handlePairClick} disabled={!isSodiumReady}>
							Pair with Extension
						</Button>
					)}

					{pairingStatus === "pairing" && <p>Generating keys and contacting extension...</p>}

					{pairingStatus === "awaitingCode" && (
						<div className="flex items-center gap-2">
							<Input
								type="text"
								placeholder="Enter 6-digit code from VS Code"
								value={pairingCodeInput}
								onChange={(e) => setPairingCodeInput(e.target.value)}
								maxLength={6}
								className="w-48"
							/>
							<Button onClick={handleVerifyCodeClick} disabled={pairingCodeInput.length !== 6}>
								Verify Code
							</Button>
						</div>
					)}

					{pairingStatus === "verifying" && <p>Verifying code...</p>}

					{pairingStatus === "paired" && <p className="text-green-500">Successfully paired!</p>}
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
					sessionSharedSecret={sessionSharedSecret} // Pass down E2EE secret
					isSodiumReady={isSodiumReady} // Pass down sodium status
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
