package main

import (
	"encoding/json" // Added for JSON marshalling
	"fmt"
	"log"
	"net/http"
	"net/http/httputil" // Added for reverse proxy
	"net/url"           // Added for reverse proxy
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/arpinfidel/Roo-Code-Remote/server/syncmap"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
)

type Session struct {
	Host    *Client
	Clients syncmap.SyncMap[*Client, struct{}]
}

// Hub maintains the set of active clients
type Hub struct {
	sessions  syncmap.SyncMap[string, Session]
	broadcast chan *WebSocketMessage
}

var (
	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			// Allow all origins for WebSocket during development proxying
			// In production, you might want stricter checks
			return true
		},
	}
	config Config
	hub    = &Hub{
		sessions:  syncmap.New[string, Session](),
		broadcast: make(chan *WebSocketMessage, 10),
	}
)

// loadConfig loads configuration from environment variables
func loadConfig() Config {
	// Load .env file if it exists
	godotenv.Load(".env")

	// Parse port with fallback
	port := 8080 // Go server port
	if portStr := os.Getenv("WS_PORT"); portStr != "" {
		fmt.Sscanf(portStr, "%d", &port)
	}

	// Parse heartbeat interval with fallback
	heartbeatInterval := 30000
	if intervalStr := os.Getenv("WS_HEARTBEAT_INTERVAL"); intervalStr != "" {
		fmt.Sscanf(intervalStr, "%d", &heartbeatInterval)
	}

	// Parse allowed origins
	allowedOrigins := []string{}
	if originsStr := os.Getenv("ALLOWED_ORIGINS"); originsStr != "" {
		allowedOrigins = strings.Split(originsStr, ",")
	}

	// Add React Dev Server URL (assuming Vite default)
	// Make this configurable via .env if needed
	reactDevServerURL := os.Getenv("REACT_DEV_SERVER_URL")
	if reactDevServerURL == "" {
		reactDevServerURL = "http://localhost:5173" // Default Vite port
	}

	return Config{
		Port:              port,
		Host:              os.Getenv("WS_HOST"),
		IsDevelopment:     os.Getenv("NODE_ENV") != "production",
		HeartbeatInterval: heartbeatInterval,
		AllowedOrigins:    allowedOrigins,
		AuthToken:         os.Getenv("WS_AUTH_TOKEN"),
		ReactDevServerURL: reactDevServerURL, // Store React dev server URL
	}
}

// run starts the hub
func (h *Hub) run() {
	for {
		select {
		case message := <-h.broadcast:
			clients := []*Client{}
			h.sessions.Range(func(sesionID string, s Session) bool {
				s.Clients.Range(func(client *Client, _ struct{}) bool {
					clients = append(clients, client)
					return true
				})
				return true
			})
			for _, c := range clients {
				c.sendMessage(message)
			}
		}
	}
}

// serveWs handles websocket requests from clients
func serveWs(w http.ResponseWriter, r *http.Request) {
	sessionID := ""
	clientType := ""
	origin := r.Header.Get("Origin")

	// Verify token in production (origins are always allowed)
	if !config.IsDevelopment {
		// Check auth token if configured
		if config.AuthToken != "" {
			requestToken := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if requestToken != config.AuthToken {
				log.Printf("Authentication failed from %s", origin)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
		}
	}

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

// newReverseProxy creates a reverse proxy to the target URL
func newReverseProxy(targetUrl string) (*httputil.ReverseProxy, error) {
	url, err := url.Parse(targetUrl)
	if err != nil {
		return nil, fmt.Errorf("failed to parse target URL '%s': %v", targetUrl, err)
	}
	proxy := httputil.NewSingleHostReverseProxy(url)

	// Optional: Modify request headers if needed
	// proxy.Director = func(req *http.Request) {
	// 	req.Header.Set("X-Forwarded-Host", req.Host)
	// 	req.Header.Set("X-Origin-Host", url.Host)
	// 	req.URL.Scheme = url.Scheme
	// 	req.URL.Host = url.Host
	// 	req.Host = url.Host // Set Host header to target host
	// }

	return proxy, nil
}

func main() {
	// Load configuration
	config = loadConfig()

	// Set up host if not provided
	if config.Host == "" {
		config.Host = "localhost"
	}

	// Start hub
	go hub.run()

	// Create the reverse proxy instance (only in development)
	var reactProxy *httputil.ReverseProxy
	var err error
	if config.IsDevelopment {
		reactProxy, err = newReverseProxy(config.ReactDevServerURL)
		if err != nil {
			log.Fatalf("Failed to create reverse proxy: %v", err)
		}
		log.Printf("Development mode: Proxying UI requests to %s", config.ReactDevServerURL)
	} else {
		// In production, you'd typically serve static files instead
		// For now, we'll just log a message if not in development
		log.Println("Production mode: Reverse proxy to dev server disabled.")
		// Add static file serving logic here if needed for production builds
	}

	// Set up HTTP server mux
	mux := http.NewServeMux()

	// --- Register API Handlers FIRST ---
	mux.HandleFunc("/ws", serveWs)
	mux.HandleFunc("/api/sessions", serveApiSessions)

	// --- Handle other requests ---
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// In development, proxy to React dev server
		if config.IsDevelopment && reactProxy != nil {
			log.Printf("Proxying request for %s to React dev server", r.URL.Path)
			reactProxy.ServeHTTP(w, r)
		} else {
			// In production (or if proxy failed), return 404 or serve static files
			// For now, just return 404 if not proxying
			log.Printf("Request for %s not handled (not proxying)", r.URL.Path)
			http.NotFound(w, r)
			// Alternatively, add static file serving logic here:
			// http.ServeFile(w, r, filepath.Join(uiBuildDir, "index.html")) etc.
		}
	})

	// --- Server Address and Startup ---
	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)

	server := &http.Server{
		Addr:    addr,
		Handler: mux, // Use the mux
	}

	// Handle graceful shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)

	go func() {
		<-stop
		log.Println("Server shutting down...")
		server.Close()
		os.Exit(0)
	}()

	// Start server
	mode := "development"
	if !config.IsDevelopment {
		mode = "production"
	}
	log.Printf("Server running in %s mode", mode)
	log.Printf("Listening on http://%s", addr) // Log http address now

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Error starting server: %v", err)
	}
}
