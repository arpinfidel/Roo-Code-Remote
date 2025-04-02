import React, { createContext, useContext, useState, useEffect } from "react"
import { WsClient } from "../lib/ws-client"

type WsContextType = {
	status: "disconnected" | "connecting" | "connected"
	connect: (url: string) => Promise<void>
	sendCommand: (command: Omit<WsMessage, "id">) => Promise<void>
	error: Error | null
}

const WsContext = createContext<WsContextType>({
	status: "disconnected",
	connect: async () => {},
	sendCommand: async () => {},
	error: null,
})

export const WsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [client] = useState(() => new WsClient())
	const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected")
	const [error, setError] = useState<Error | null>(null)

	const connect = async (url: string) => {
		try {
			setStatus("connecting")
			await client.connect(url)
		} catch (err) {
			setError(err as Error)
			setStatus("disconnected")
		}
	}

	const sendCommand = async (command: Omit<WsMessage, "id">) => {
		if (status !== "connected") {
			throw new Error("Not connected to WebSocket server")
		}
		return client.send(command)
	}

	useEffect(() => {
		const handleConnected = () => setStatus("connected")
		const handleDisconnected = () => setStatus("disconnected")
		const handleError = (event: CustomEvent<Error>) => setError(event.detail)

		client.on("connected", handleConnected)
		client.on("disconnected", handleDisconnected)
		client.on("error", handleError)

		return () => {
			client.off("connected", handleConnected)
			client.off("disconnected", handleDisconnected)
			client.off("error", handleError)
		}
	}, [client])

	return <WsContext.Provider value={{ status, connect, sendCommand, error }}>{children}</WsContext.Provider>
}

export const useWs = () => useContext(WsContext)

interface WsMessage {
	id: string
	type: string
	action?: string
	payload?: unknown
}
