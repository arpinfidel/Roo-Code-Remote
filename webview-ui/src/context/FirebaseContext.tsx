import { initializeApp, FirebaseApp } from "firebase/app"
import { getAnalytics, Analytics } from "firebase/analytics"
import { getAuth, Auth, signInWithCustomToken, User } from "firebase/auth"
import { createContext, useContext, useEffect, useState } from "react"
import { useEvent } from "react-use"
import { ExtensionMessage } from "../../../src/shared/ExtensionMessage"

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
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null)

export function FirebaseProvider({ children }: { children: React.ReactNode }) {
	const [firebase, setFirebase] = useState<FirebaseContextValue | null>(null)
	const [user, setUser] = useState<User | null>(null)
	const [isAuthenticated, setIsAuthenticated] = useState(false)
	const [authChecked, setAuthChecked] = useState(false)

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
			} else {
				console.log("User not authenticated")
			}
		})

		setFirebase({ app, analytics, auth, user, isAuthenticated, authChecked })

		return () => {
			// Cleanup auth listener on unmount
			unsubscribe()
		}
	}, [])

	useEvent("message", (event: MessageEvent) => {
		const data: ExtensionMessage = event.data
		if (data.type === "setToken") {
			console.log(data)
			console.log(data.text)
			if (firebase?.auth && data.text) {
				signInWithCustomToken(firebase.auth, data.text)
					.then(() => {
						console.log("logged in with custom token")
					})
					.catch((error) => {
						console.log("error logging in with custom token", error)
						console.log("error logging in with custom token", error.code)
						console.log("error logging in with custom token", error.message)
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
				authChecked
			})
		}
	}, [user, isAuthenticated, authChecked])

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
