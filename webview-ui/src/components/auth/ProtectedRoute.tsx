import { ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { useFirebase } from "../../context/FirebaseContext"

interface ProtectedRouteProps {
	children: ReactNode
}

export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
	const { authChecked, isAuthenticated } = useFirebase()
	const location = useLocation()

	// Show loading state while auth state is being determined
	if (!authChecked) {
		return <div>Loading...</div>
	}

	// If not authenticated, redirect to login with the current path as redirect_url
	if (!isAuthenticated) {
		console.log("Not authenticated. Redirecting to login.")
		return (
			<Navigate to={`/login?redirect_url=${encodeURIComponent(location.pathname + location.search)}`} replace />
		)
	}

	return <>{children}</>
}
