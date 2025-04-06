package main

import (
	"context"
	"log"
	"net/http"
	"strings"
)

// contextKey is a custom type for context keys to avoid collisions
type contextKey string

// userIDKey is the key used to store the user ID in the request context
const userIDKey contextKey = "uid"

// GetUserID extracts the authenticated user ID from the request context
func GetUserID(r *http.Request) (string, bool) {
	uid, ok := r.Context().Value(userIDKey).(string)
	return uid, ok
}

func GetAuthToken(r *http.Request) string {
	authHeader := r.Header.Get("Authorization")
	if authHeader != "" {
		return authHeader
	}
	if tok := r.URL.Query().Get("auth_token"); tok != "" {
		return tok
	}

	return ""
}

// AuthMiddleware verifies Firebase ID tokens in the Authorization header
func AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authToken := GetAuthToken(r)
		if authToken == "" {
			http.Error(w, "Authorization header is required", http.StatusUnauthorized)
			return
		}

		// Check if the header has the correct format
		parts := strings.Split(authToken, " ")
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			http.Error(w, "Authorization header format must be 'Bearer {token}'", http.StatusUnauthorized)
			return
		}

		// Extract the token
		idToken := parts[1]

		// Verify the Firebase ID token
		token, err := firebaseAuth.VerifyIDToken(context.Background(), idToken)
		if err != nil {
			log.Printf("Error verifying ID token: %v", err)
			http.Error(w, "Invalid or expired token", http.StatusUnauthorized)
			return
		}

		// Add the verified user ID to the request context
		ctx := context.WithValue(r.Context(), userIDKey, token.UID)

		// Call the next handler with the updated context
		next(w, r.WithContext(ctx))
	}
}
