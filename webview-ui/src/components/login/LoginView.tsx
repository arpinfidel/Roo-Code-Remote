import { useEffect, useRef } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { GoogleAuthProvider, signInWithPopup, setPersistence, browserLocalPersistence } from "firebase/auth"
import { useFirebase } from "../../context/FirebaseContext"

async function getFirebaseCustomToken(uid: string): Promise<string> {
	try {
		const response = await fetch(`/api/firebase-token?uid=${uid}`, {
			headers: {
				Authorization: `Bearer ${process.env.WS_AUTH_TOKEN || ""}`,
			},
		})

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`)
		}

		const data = await response.json()
		return data.token
	} catch (error) {
		console.error("Error fetching custom token:", error)
		throw error
	}
}

export const LoginView = () => {
	const { auth } = useFirebase()
	const navigate = useNavigate()
	const [searchParams] = useSearchParams()
	const redirectUrl = searchParams.get("redirect_url") || "/app"
	const getToken = searchParams.get("get_token") === "true"
	const authInProgress = useRef(false)

	useEffect(() => {
		const handleAuth = async () => {
			// Prevent multiple auth attempts
			if (authInProgress.current) return
			authInProgress.current = true

			try {
				await setPersistence(auth, browserLocalPersistence)

				const provider = new GoogleAuthProvider()
				provider.addScope("profile")
				provider.addScope("email")

				if (!auth.currentUser) {
					const result = await signInWithPopup(auth, provider)
					console.log("Login successful", result.user, "redirecting to", redirectUrl)
				}

				const url = new URL(
					redirectUrl.includes("://")
						? redirectUrl
						: `${window.location.origin}${redirectUrl.startsWith("/") ? "" : "/"}${redirectUrl}`,
				)

				// Get Firebase custom token from backend
				if (getToken) {
					if (!auth.currentUser) {
						console.error("auth current user is not set")
					} else {
						const customToken = await getFirebaseCustomToken(auth.currentUser.uid)
						url.searchParams.set("token", customToken)
					}
				}

				const urlString = url.toString()
				window.open(urlString, "_self")
			} catch (error: unknown) {
				if (error instanceof Error && "code" in error && error.code !== "auth/cancelled-popup-request") {
					console.error("Login error:", error)
					navigate("/")
				}
			} finally {
				authInProgress.current = false
			}
		}

		handleAuth()

		return () => {
			// Cleanup if component unmounts
			authInProgress.current = false
		}
	}, [auth, navigate, redirectUrl, getToken])

	return null
}
