import { initializeApp, FirebaseApp } from "firebase/app"
import { getAnalytics, Analytics } from "firebase/analytics"
import { getAuth, Auth, signInWithCustomToken, User } from "firebase/auth"
import { createContext, useContext, useEffect, useState } from "react"
import { useEvent } from "react-use"
import { ExtensionMessage } from "../../../src/shared/ExtensionMessage"
import { vscode } from "../utils/vscode" // Import the vscode utility

// Firebase configuration
const firebaseConfig = {
	apiKey: "AIzaSyCg8qAp4YPbEcdj8KgCad26WLgZnls1IJg",
	authDomain: "roo-code-remote.firebaseapp.com",
	projectId: "roo-code-remote",
	storageBucket: "roo-code-remote.firebasestorage.app",
	messagingSenderId: "459487970034",
	appId: "1:459487970034:web:892ef2868979100cb1866b",
	measurementId: "G-NHS52YB75Y",
}

interface FirebaseContextValue {
	app: FirebaseApp
	analytics: Analytics
	auth: Auth
	user: User | null
	isAuthenticated: boolean
	authChecked: boolean
	idToken: string | null // Add idToken state
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null)

export function FirebaseProvider({ children }: { children: React.ReactNode }) {
	const [firebase, setFirebase] = useState<FirebaseContextValue | null>(null)
	const [user, setUser] = useState<User | null>(null)
	const [isAuthenticated, setIsAuthenticated] = useState(false)
	const [authChecked, setAuthChecked] = useState(false)
	const [idToken, setIdToken] = useState<string | null>(null) // State for ID token

	useEffect(() => {
		// Initialize Firebase
		const app = initializeApp(firebaseConfig)
		const analytics = getAnalytics(app)
		const auth = getAuth(app)

		// Set up auth state listener to properly track authentication status
		const unsubscribe = auth.onAuthStateChanged((currentUser) => {
			setUser(currentUser)
			setIsAuthenticated(!!currentUser)
			setAuthChecked(true)
			if (currentUser) {
				console.log("User authenticated:", currentUser.uid)
				// Get the ID token and send it to the extension
				currentUser
					.getIdToken(true)
					.then((idToken) => {
						setIdToken(idToken); // Store token in state
						vscode.postMessage({ type: "firebaseIdToken", text: idToken })
					})
					.catch((error) => {
						console.error("Error getting ID token:", error)
					})
			} else {
				console.log("User not authenticated")
				// Optionally send a null token or clear message
				setIdToken(null); // Clear token state
				vscode.postMessage({ type: "firebaseIdToken", text: "" })
			}
		})

		setFirebase({ app, analytics, auth, user, isAuthenticated, authChecked, idToken })

		return () => {
			// Cleanup auth listener on unmount
			unsubscribe()
		}
	}, [authChecked, isAuthenticated, user, idToken]) // Add idToken dependency

	useEvent("message", (event: MessageEvent) => {
		const data: ExtensionMessage = event.data
		if (data.type === "setToken") {
			console.log(data)
			console.log(data.text)
			if (firebase?.auth && data.text) {
				signInWithCustomToken(firebase.auth, data.text)
					.then((userCredential) => {
						console.log("logged in with custom token")
						// Get the ID token after custom sign-in and send it
						userCredential.user
							.getIdToken(true)
							.then((idToken) => {
								setIdToken(idToken); // Store token in state
								vscode.postMessage({ type: "firebaseIdToken", text: idToken })
							})
							.catch((error) => {
								console.error("Error getting ID token after custom sign-in:", error)
							})
					})
					.catch((error) => {
						console.log("error logging in with custom token", error)
						console.log("error logging in with custom token", error.code)
						console.log("error logging in with custom token", error.message)
						// Optionally send a null token or error message
						setIdToken(null); // Clear token state
						vscode.postMessage({ type: "firebaseIdToken", text: "" })
					})
			}
		}
	})

	// Update the firebase context value when auth state changes
	useEffect(() => {
		if (firebase) {
			setFirebase({
				...firebase,
				user,
				isAuthenticated,
				authChecked,
				idToken, // Include idToken in updated context value
			})
		}
	}, [user, isAuthenticated, authChecked, firebase, idToken]) // Add idToken dependency

	if (!firebase) {
		return null // Or loading indicator
	}

	return <FirebaseContext.Provider value={firebase}>{children}</FirebaseContext.Provider>
}

export function useFirebase() {
	const context = useContext(FirebaseContext)
	if (!context) {
		throw new Error("useFirebase must be used within a FirebaseProvider")
	}
	return context
}
