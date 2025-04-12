import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react"
import { EncryptedWsClient } from "../lib/e2ee/encryptedWsClient" // Import the encrypted client
import { initializeSodium } from "../lib/e2ee/crypto" // Import local crypto copy

// Define E2EE State type locally or import if shared
type E2EEState =
	| 'uninitialized' | 'disconnected' | 'connecting' | 'checking_pairing'
	| 'requesting_pairing' | 'awaiting_peer_pubkey' | 'awaiting_pairing_code' // Add missing state
	| 'awaiting_verification'
	| 'paired' | 'pairing_failed';

// Define the user-facing status, derived from WS and E2EE state
type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error" | "pairing_required";

type WsContextType = {
	status: ConnectionStatus // User-facing status
	e2eeState: E2EEState // Detailed E2EE state
	connect: (url: string) => Promise<void>
	sendCommand: (command: Omit<WsMessage, "id" | "clientType">) => Promise<void> // Align command type
	submitPairingCode: (code: string) => Promise<void> // Function to submit code
	error: Error | null
	client: EncryptedWsClient // Expose the encrypted client instance
}

const WsContext = createContext<WsContextType>({
	status: "disconnected",
	e2eeState: 'uninitialized',
	connect: async () => { throw new Error("WsProvider not initialized"); },
	sendCommand: async () => { throw new Error("WsProvider not initialized"); },
	submitPairingCode: async () => { throw new Error("WsProvider not initialized"); },
	error: null,
	client: null as any, // Will be replaced by useState instance
})

export const WsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	// Use EncryptedWsClient - potentially as a singleton via getEncryptedWsClient() if preferred
	const [client] = useState(() => new EncryptedWsClient())
	const [status, setStatus] = useState<ConnectionStatus>("disconnected")
	const [e2eeState, setE2EEState] = useState<E2EEState>('uninitialized');
	const [error, setError] = useState<Error | null>(null)
	const isSodiumInitialized = useRef(false); // Track sodium init

	// Initialize Sodium on mount
	useEffect(() => {
		if (!isSodiumInitialized.current) {
			initializeSodium()
				.then(() => {
					isSodiumInitialized.current = true;
					console.log("Sodium initialized in WsProvider.");
					// Update initial E2EE state if needed, though client constructor does this
					setE2EEState(client.getE2EEState());
			})
			.catch((err: unknown) => { // Add unknown type
				console.error("Sodium initialization failed in WsProvider:", err);
				setError(err instanceof Error ? err : new Error(String(err ?? 'Unknown sodium init error'))); // Type check error
				setStatus("error");
				setE2EEState('pairing_failed');
			});
		}
	}, [client]); // Add client dependency

	const connect = useCallback(async (url: string) => {
		if (!isSodiumInitialized.current) {
			console.warn("Attempted to connect before Sodium initialized.");
			setError(new Error("Cryptography library not ready."));
			setStatus("error");
			return;
		}
		// Check current status from the client itself to avoid race conditions
		const currentWsStatus = client.getStatus ? client.getStatus() : 'disconnected'; // Assuming getStatus exists on EncryptedClient or underlying
		const currentE2EEState = client.getE2EEState();

		if (currentWsStatus === "connected" || currentWsStatus === "connecting" || currentE2EEState === 'paired') {
			console.log("Connection/Pairing already in progress or established.");
			return;
		}

		console.log(`WsProvider: connecting to ${url}`)
		setStatus("connecting") // Set user-facing status
		setError(null); // Clear previous errors
		try {
			// Encrypted client handles underlying connection and pairing flow
			await client.connect()
			// Status updates will be handled by event listeners
		} catch (err) {
			console.error("WsProvider: connect error", err);
			setError(err as Error)
			setStatus("error") // Set specific error status
			setE2EEState(client.getE2EEState()); // Reflect E2EE state on error
		}
	}, [client]) // Add client dependency

	const sendCommand = useCallback(async (command: Omit<WsMessage, "id" | "clientType">) => {
		// Check E2EE state - should be 'paired' to send commands
		if (client.getE2EEState() !== "paired") {
			console.error("Attempted to send command before E2EE channel established.");
			throw new Error("Secure connection not established.")
		}
		// Encrypted client handles encryption
		return client.send(command)
	}, [client]) // Add client dependency

	const submitPairingCode = useCallback(async (code: string) => {
		// Check against the correct state name used in EncryptedWsClient
		if (client.getE2EEState() !== 'awaiting_pairing_code') {
			console.warn("submitPairingCode called in incorrect E2EE state:", client.getE2EEState());
			throw new Error(`Not currently awaiting pairing code (state is ${client.getE2EEState()}).`);
		}
		if (!isSodiumInitialized.current) {
			throw new Error("Cryptography library not ready.");
		}
		// Call the client's method to handle code submission and verification
		await client.submitPairingCode(code);
		// Status updates (e.g., to 'paired' or 'error') will come via events
	}, [client]); // Add client dependency

	// Effect to handle events from EncryptedWsClient
	useEffect(() => {
		const handleE2EEStateChange = (event: CustomEvent<E2EEState>) => {
			const newState = event.detail;
			console.log("WsProvider: handleE2EEStateChange - New E2EE State:", newState); // Log received state
			setE2EEState(newState);
			setError(null); // Clear error on state change

			// Update user-facing status based on E2EE state
			switch (newState) {
				case 'paired':
					console.log("WsProvider: Setting status to 'connected'"); // Log status change
					setStatus("connected");
					break;
				case 'connecting':
				case 'checking_pairing':
				case 'requesting_pairing':
				case 'awaiting_peer_pubkey': // Still connecting from user perspective
				case 'awaiting_verification':
					console.log("WsProvider: Setting status to 'connecting'"); // Log status change
					setStatus("connecting");
					break;
				case 'pairing_failed':
					console.log("WsProvider: Setting status to 'error' (pairing failed)"); // Log status change
					setStatus("error");
					// Optionally set a specific error message
					setError(new Error("E2EE Pairing Failed"));
					break;
				case 'disconnected':
					console.log("WsProvider: Setting status to 'disconnected'"); // Log status change
					setStatus("disconnected");
					break;
				case 'uninitialized':
				    console.log("WsProvider: Setting status to 'disconnected' (uninitialized)"); // Log status change
				    setStatus("disconnected"); // Treat as disconnected initially
				    break;
			}
		};

		const handlePairingRequired = () => {
			console.log("WsProvider: handlePairingRequired - Setting status to 'pairing_required'"); // Log event
			setStatus("pairing_required"); // Set specific status for UI
		};

		const handleDisconnect = (event?: CustomEvent<any>) => {
			console.log("WsProvider: handleDisconnect - Setting status to 'disconnected'"); // Log event
			setStatus("disconnected");
			setE2EEState('disconnected'); // Ensure E2EE state reflects disconnect
			// Optionally capture close event details if provided
			console.log("WebSocket disconnected:", event?.detail);
		};

		const handleError = (event: CustomEvent<Error>) => {
			console.log("WsProvider: handleError - Setting status to 'error'"); // Log event
			setError(event.detail);
			setStatus("error");
			// Also update E2EE state if it's not already failed
			if (client.getE2EEState() !== 'pairing_failed') {
				setE2EEState('pairing_failed'); // Assume pairing failed on error
			}
			console.error("WebSocket/E2EE Error Event:", event.detail);
		};

		// Assuming EncryptedWsClient uses standard event names or its static Events map
		client.on(EncryptedWsClient.Events.E2EEStateChange, handleE2EEStateChange);
		client.on(EncryptedWsClient.Events.PairingRequired, handlePairingRequired);
		client.on(EncryptedWsClient.Events.Disconnected, handleDisconnect);
		client.on(EncryptedWsClient.Events.Error, handleError);
		// We don't need a separate 'connected' listener as 'paired' state handles it

		// Initial state sync
		setE2EEState(client.getE2EEState());
		setStatus(client.getStatus ? client.getStatus() : 'disconnected'); // Sync initial status if possible


		return () => {
			// Use the same event names/map for removal
			client.off(EncryptedWsClient.Events.E2EEStateChange, handleE2EEStateChange);
			client.off(EncryptedWsClient.Events.PairingRequired, handlePairingRequired);
			client.off(EncryptedWsClient.Events.Disconnected, handleDisconnect);
			client.off(EncryptedWsClient.Events.Error, handleError);
		};
	}, [client]); // Rerun effect if client instance changes (though it shouldn't here)


	// Provide the updated context value
	return <WsContext.Provider value={{ status, e2eeState, connect, sendCommand, submitPairingCode, error, client }}>{children}</WsContext.Provider>
}

export const useWs = () => useContext(WsContext)

// Use a more specific type for commands sent from UI, aligning with EncryptedClient's send method
// Or import the shared WebSocketMessage type if paths allow and it's compatible
interface WsMessage {
	// id?: string; // ID is handled by client
	type: string; // Should align with WebSocketMessageType
	action?: string;
	payload?: any;
	error?: string;
	clientType?: "webui" | "extension";
}
