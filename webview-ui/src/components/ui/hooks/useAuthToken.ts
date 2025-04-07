import { useCallback, useEffect, useState } from "react"
import { useFirebase } from "../../../context/FirebaseContext"

/**
 * Custom hook to get Firebase authentication token and properly formatted headers
 * for authenticated API requests.
 *
 * @returns An object containing:
 * - getAuthHeaders: Function that returns headers with the current auth token
 * - token: The current Firebase ID token
 * - isLoading: Boolean indicating if the token is being fetched
 * - error: Any error that occurred during token fetching
 */
export function useAuthToken() {
	const { user, isAuthenticated } = useFirebase()
	const [token, setToken] = useState<string | null>(null)
	const [isLoading, setIsLoading] = useState<boolean>(false)
	const [error, setError] = useState<Error | null>(null)

	// Function to fetch the token
	const fetchToken = useCallback(async () => {
		if (!user) {
			setToken(null)
			return null
		}

		setIsLoading(true)
		setError(null)

		try {
			const idToken = await user.getIdToken(true)
			setToken(idToken)
			return idToken
		} catch (err) {
			console.error("Error getting auth token:", err)
			setError(err instanceof Error ? err : new Error("Failed to get authentication token"))
			return null
		} finally {
			setIsLoading(false)
		}
	}, [user])

	// Fetch token on mount and when user changes
	useEffect(() => {
		if (isAuthenticated && user) {
			fetchToken()
		} else {
			setToken(null)
		}
	}, [isAuthenticated, user, fetchToken])

	// Function to get headers with auth token
	const getAuthHeaders = useCallback(
		async (forceRefresh = false) => {
			const currentToken = forceRefresh ? await fetchToken() : token || (await fetchToken())

			return {
				Authorization: `Bearer ${currentToken || ""}`,
				"Content-Type": "application/json",
			}
		},
		[token, fetchToken],
	)

	// Function to get a custom token from the backend
	const getCustomToken = useCallback(
		async (uid: string): Promise<string> => {
			try {
				const headers = await getAuthHeaders()
				const response = await fetch(`/api/firebase-token?uid=${uid}`, { headers })

				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`)
				}

				const data = await response.json()
				return data.token
			} catch (error) {
				console.error("Error fetching custom token:", error)
				throw error
			}
		},
		[getAuthHeaders],
	)

	return {
		token,
		isLoading,
		error,
		getAuthHeaders,
		getCustomToken,
		refreshToken: fetchToken,
	}
}
