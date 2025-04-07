package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/arpinfidel/Roo-Code-Remote/server/syncmap"
	"github.com/google/uuid"
)

// serveWs handles websocket requests from clients
func serveWs(w http.ResponseWriter, r *http.Request) {
	sessionID := ""
	clientType := ""

	sessionID = r.URL.Query().Get("session_id")
	if sessionID == "" {
		log.Printf("Missing session ID from %s", r.URL.String())
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}

	clientType = r.URL.Query().Get("client_type")
	if clientType == "" {
		log.Printf("Missing client type from %s", r.URL.String())
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}

	if _, ok := hub.sessions.Get(sessionID); clientType == string(WebUI) && !ok {
		log.Printf("Session doesn't exist %s", r.URL.String())
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Error upgrading connection:", err)
		return
	}

	client := &Client{
		sessionID:  sessionID,
		conn:       conn,
		isAlive:    true,
		clientID:   uuid.New().String(),
		clientType: ClientType(clientType),
	}

	sess, ok := hub.sessions.Get(sessionID)
	if !ok {
		sess = Session{
			Clients: syncmap.New[*Client, struct{}](),
		}
	}
	if clientType == string(Extension) {
		sess.Host = client
	} else {
		clientConnected := WebSocketMessage{
			ID:        uuid.New().String(),
			Type:      ClientConnected,
			Origin:    conn.RemoteAddr().String(),
			Timestamp: time.Now().UnixMilli(),
			ClientID:  client.clientID,
		}
		// Check if Host exists before sending message
		if sess.Host != nil {
			sess.Host.sendMessage(&clientConnected)
		} else {
			log.Printf("Warning: WebUI client connected to session %s but host (Extension) is not present.", sessionID)
		}
		sess.Clients.Set(client, struct{}{})
	}

	hub.sessions.Set(sessionID, sess)

	fmt.Printf("Client connected: %s (%s)\n", client.clientType, client.sessionID)

	// Start client goroutines
	go client.writePump()
	go client.readPump()
}

// serveApiSessions handles requests for the list of active sessions
func serveApiSessions(w http.ResponseWriter, r *http.Request) {
	// Set CORS header (still useful if API is called directly sometimes)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	// Structure to hold session info for the API response
	type ApiSessionInfo struct {
		ID   string `json:"id"`
		Name string `json:"name"` // Can add more fields like host client ID if needed
	}

	var sessionList []ApiSessionInfo

	// Iterate safely through the sessions map
	hub.sessions.Range(func(sessionID string, session Session) bool {
		// Only list sessions that have an active host (extension)
		if session.Host != nil {
			sessionList = append(sessionList, ApiSessionInfo{
				ID:   sessionID,
				Name: fmt.Sprintf("Session %s", sessionID), // Simple name for now
			})
		}
		return true // Continue iteration
	})

	// Marshal the list into JSON
	jsonData, err := json.Marshal(sessionList)
	if err != nil {
		log.Printf("Error marshalling session list: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	// Write the JSON response
	w.WriteHeader(http.StatusOK)
	w.Write(jsonData)
}

func serveFirebaseToken(w http.ResponseWriter, r *http.Request) {
	// Get UID from request
	uid := r.URL.Query().Get("uid")
	if uid == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "uid is required"})
		return
	}

	// Generate custom token
	token, err := firebaseAuth.CustomToken(context.Background(), uid)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}
