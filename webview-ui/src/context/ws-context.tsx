import React, { createContext, useContext, useState, useEffect, useCallback } from "react" // Import useCallback
// Combine imports from the same module
import { EncryptedWsClient, WebSocketMessageType } from "../lib/e2ee/encrypted-ws-client"
import { PairingState } from "../lib/e2ee/pairing" // Import PairingState
import { useFirebase } from "./FirebaseContext" // Import useFirebase to get token

// Define message type based on EncryptedWsClient's expectations if needed, or rely on client's internal types
// Assuming EncryptedWsClient's send method handles the structure
type WsCommandPayload = any; // Define more specifically if possible

type WsContextType = {
	status: "disconnected" | "connecting" | "connected"
	pairingState: PairingState
	pairingCode: string | null
	connect: () => Promise<void> // Connect doesn't need URL directly now, gets from config/state
	// Use specific message type for commands
	sendCommand: (command: { type: WebSocketMessageType; payload?: WsCommandPayload }) => Promise<void>
	initiatePairing: () => Promise<void>
	confirmPairing: () => Promise<void>
	resetPairing: () => void
	error: Error | null
	client: EncryptedWsClient // Use the encrypted client type
}

const WsContext = createContext<WsContextType>({
	status: "disconnected",
	pairingState: "unpaired",
	pairingCode: null,
	connect: async () => {},
	sendCommand: async () => {},
	initiatePairing: async () => {},
	confirmPairing: async () => {},
	resetPairing: () => {},
	error: null,
	// Initialize client later in provider to access hooks
	client: null as any, // Placeholder, will be replaced by useState
})

export const WsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	// Use Firebase context to get auth token
	const { idToken } = useFirebase();
	// Initialize client state, ensuring it's created only once
	const [client] = useState(() => {
		// TODO: Get URL, Session ID from appropriate source (e.g., URL params, state management)
		const urlParams = new URLSearchParams(window.location.search);
		const sessionId = urlParams.get("session_id");
		const wsUrl = import.meta.env.VITE_WS_URL || "ws://localhost:8080/ws"; // Get from env or default

		return new EncryptedWsClient({
			url: wsUrl,
			clientType: "webui",
			sessionId: sessionId,
			authToken: null, // Token will be set before connecting
		});
	});
	const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected")
	const [pairingState, setPairingState] = useState<PairingState>("unpaired")
	const [pairingCode, setPairingCode] = useState<string | null>(null)
	const [error, setError] = useState<Error | null>(null)

	// Wrap connect in useCallback to stabilize its reference for useEffect dependency
	const connect = useCallback(async () => {
		console.log(`Attempting WS connection...`)
		if (status === "connected" || status === "connecting") {
			console.log("Connection already in progress or established.");
			return
		}
		if (!idToken) {
			setError(new Error("Cannot connect: Firebase ID token not available."));
			console.error("Cannot connect: Firebase ID token not available.");
			return;
		}
		try {
			setStatus("connecting")
			setError(null); // Clear previous errors
			// Set necessary config before connecting
			client.setAuthToken(idToken); // Use the setter method
			// Initialize E2EE keys if not already done (client.initialize does this)
			await client.initialize();
			await client.connect()
			// Status will be updated by 'connected' event listener
		} catch (err) {
			console.error("Connection failed:", err);
			setError(err as Error)
			setStatus("disconnected") // Ensure status reflects failure
		}
	}, [status, idToken, client]); // Add dependencies for useCallback

	// Send command using the encrypted client
	// Use specific message type for commands
	const sendCommand = async (command: { type: WebSocketMessageType; payload?: WsCommandPayload }) => {
		if (status !== "connected") {
			throw new Error("Not connected to WebSocket server")
		}
		// Encrypted client handles adding ID, clientType, peerPublicKey, and encryption
		return client.send(command)
	}

	// E2EE Control Functions
	const initiatePairing = async () => {
		if (status !== "connected") {
			throw new Error("Cannot initiate pairing: Not connected.");
		}
		await client.initiatePairing();
	};
	const confirmPairing = async () => {
		if (pairingState !== "awaiting-confirmation") {
			throw new Error("Cannot confirm pairing: Not awaiting confirmation.");
		}
		await client.confirmPairing();
	};
	const resetPairing = () => {
		// Optionally disconnect or just reset keys/state
		client.resetPairing();
	};

	useEffect(() => {
		// Setup listeners for connection and E2EE events
		const handleConnected = () => { setStatus("connected"); setError(null); };
		const handleDisconnected = () => { setStatus("disconnected"); setPairingState("unpaired"); setPairingCode(null); }; // Reset pairing on disconnect
		const handleError = (event: Event) => setError((event as CustomEvent).detail as Error);
		const handlePairingStateChange = (event: Event) => setPairingState((event as CustomEvent).detail as PairingState);
		const handlePairingCode = (event: Event) => setPairingCode((event as CustomEvent).detail as string);
		const handlePaired = () => { setPairingState("paired"); setPairingCode(null); }; // Clear code when paired
		const handleUnpaired = () => { setPairingState("unpaired"); setPairingCode(null); };

		client.addEventListener("connected", handleConnected)
		client.addEventListener("disconnected", handleDisconnected)
		client.addEventListener("error", handleError)
		client.addEventListener("pairing-state-change", handlePairingStateChange);
		client.addEventListener("pairing-code", handlePairingCode);
		client.addEventListener("paired", handlePaired);
		client.addEventListener("unpaired", handleUnpaired);


		// Auto-connect if Firebase token is available
		if (idToken && status === 'disconnected') {
			connect();
		}

		return () => {
			client.removeEventListener("connected", handleConnected)
			client.removeEventListener("disconnected", handleDisconnected)
			client.removeEventListener("error", handleError)
			client.removeEventListener("pairing-state-change", handlePairingStateChange);
			client.removeEventListener("pairing-code", handlePairingCode);
			client.removeEventListener("paired", handlePaired);
			client.removeEventListener("unpaired", handleUnpaired);
			// Optional: client.disconnect() on unmount? Depends on desired behavior.
		}
	}, [client, idToken, connect, status]); // Dependencies are now correct with useCallback

	// Provide E2EE state and functions in context value
	const contextValue = {
		status,
		pairingState,
		pairingCode,
		connect,
		sendCommand,
		initiatePairing,
		confirmPairing,
		resetPairing,
		error,
		client,
	};

	return <WsContext.Provider value={contextValue}>{children}</WsContext.Provider>
}

export const useWs = () => useContext(WsContext)

// Remove local WsMessage definition
