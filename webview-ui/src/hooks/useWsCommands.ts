import { useState } from "react"
import { useWs } from "../context/ws-context"

type CommandStatus = "idle" | "pending" | "success" | "error"

export const useWsCommands = () => {
	const { sendCommand, status } = useWs()
	const [commandStatus, setCommandStatus] = useState<CommandStatus>("idle")
	const [error, setError] = useState<string | null>(null)

	const execute = async (action: string, payload?: unknown) => {
		try {
			setCommandStatus("pending")
			await sendCommand({
				type: "command",
				action,
				payload,
			})
			setCommandStatus("success")
			return true
		} catch (err) {
			setError(err instanceof Error ? err.message : "Command failed")
			setCommandStatus("error")
			return false
		} finally {
			setTimeout(() => setCommandStatus("idle"), 3000)
		}
	}

	return {
		execute,
		status: {
			ws: status,
			command: commandStatus,
		},
		error,
		isReady: status === "connected",
	}
}
