import React, { useState, useEffect } from "react"
import { Link } from "react-router-dom"
// Removed useWs import as it's no longer needed for fetching sessions here
// import { useWs } from '../../context/ws-context';

// Define an interface for the session data expected from the API
interface ApiSessionInfo {
	id: string
	name: string
}

const ActiveSessionsView: React.FC = () => {
	// Removed ws context usage for fetching
	// const { client, status, sendCommand, error: wsError } = useWs();
	const [activeSessions, setActiveSessions] = useState<ApiSessionInfo[]>([]) // State for sessions
	const [isLoading, setIsLoading] = useState(true) // Loading state
	const [error, setError] = useState<string | null>(null) // Error state for fetch

	useEffect(() => {
		const fetchSessions = async () => {
			setIsLoading(true)
			setError(null)
			try {
				// Assuming the API is served from the same origin, otherwise use full URL
				// e.g., const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
				// const response = await fetch(`${apiUrl}/api/sessions`);
				const response = await fetch("/api/sessions") // Relative path

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`)
				}

				const data: ApiSessionInfo[] = await response.json()
				setActiveSessions(data || [])
			} catch (e) {
				console.error("Failed to fetch active sessions:", e)
				setError(e instanceof Error ? e.message : "An unknown error occurred")
			} finally {
				setIsLoading(false)
			}
		}

		fetchSessions()

		// No cleanup needed for fetch like with WebSocket listeners
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []) // Empty dependency array means this runs once on mount

	return (
		<div className="p-4">
			<h1 className="text-xl font-bold mb-4">Active Sessions</h1>
			{isLoading ? (
				<p>Loading active sessions...</p>
			) : error ? (
				<p className="text-red-500">Error fetching sessions: {error}</p>
			) : activeSessions.length === 0 ? (
				<p>No active sessions found.</p>
			) : (
				<ul>
					{activeSessions.map((session) => (
						<li key={session.id} className="mb-2">
							<Link to={`/app?session_id=${session.id}`} className="text-blue-500 hover:underline">
								{/* Use the name from the API */}
								Connect to: {session.name} (ID: {session.id})
							</Link>
						</li>
					))}
				</ul>
			)}
			<p className="mt-4 text-sm text-gray-500">(This page is only visible in the standalone Web UI)</p>
		</div>
	)
}

export default ActiveSessionsView
