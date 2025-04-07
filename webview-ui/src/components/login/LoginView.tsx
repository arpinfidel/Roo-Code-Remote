import { useState, useRef } from "react"
import { useSearchParams } from "react-router-dom"
import { GoogleAuthProvider, signInWithPopup, setPersistence, browserLocalPersistence } from "firebase/auth"
import { useFirebase } from "../../context/FirebaseContext"
import { Button } from "../ui/button"
import { useAuthToken } from "../ui/hooks"

export const LoginView = () => {
	const { auth } = useFirebase()
	const { getCustomToken } = useAuthToken()
	const [searchParams] = useSearchParams()
	const redirectUrl = searchParams.get("redirect_url") || "/app"
	const getToken = searchParams.get("get_token") === "true"
	const authInProgress = useRef(false)
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const handleGoogleSignIn = async () => {
		// Prevent multiple auth attempts
		if (authInProgress.current) return
		authInProgress.current = true
		setIsLoading(true)
		setError(null)

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
					const customToken = await getCustomToken(auth.currentUser.uid)
					url.searchParams.set("token", customToken)
				}
			}

			const urlString = url.toString()
			window.open(urlString, "_self")
		} catch (error: unknown) {
			if (error instanceof Error && "code" in error && error.code !== "auth/cancelled-popup-request") {
				console.error("Login error:", error)
				setError("An error occurred during login. Please try again.")
			}
		} finally {
			authInProgress.current = false
			setIsLoading(false)
		}
	}

	return (
		<div className="flex flex-col items-center justify-center min-h-screen p-4 bg-vscode-editor-background">
			<div className="w-full max-w-md p-6 space-y-6 bg-vscode-panel-background rounded shadow-lg border border-vscode-panel-border">
				<div className="text-center">
					<h1 className="text-2xl font-bold text-vscode-foreground mb-2">Welcome to Roo</h1>
					<p className="text-vscode-descriptionForeground">Sign in to continue</p>
				</div>

				{error && (
					<div className="p-3 bg-destructive/20 border border-destructive/50 rounded text-sm text-destructive-foreground">
						{error}
					</div>
				)}

				<div className="space-y-4">
					<Button
						className="w-full flex items-center justify-center gap-2"
						onClick={handleGoogleSignIn}
						disabled={isLoading}>
						<svg width="18" height="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
							<path
								fill="#FFC107"
								d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"
							/>
							<path
								fill="#FF3D00"
								d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"
							/>
							<path
								fill="#4CAF50"
								d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"
							/>
							<path
								fill="#1976D2"
								d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"
							/>
						</svg>
						{isLoading ? "Signing in..." : "Sign in with Google"}
					</Button>
				</div>
			</div>
		</div>
	)
}
