package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"

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
			return true // Origin is checked in the handler
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
	port := 8080
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

	return Config{
		Port:              port,
		Host:              os.Getenv("WS_HOST"),
		IsDevelopment:     os.Getenv("NODE_ENV") != "production",
		HeartbeatInterval: heartbeatInterval,
		AllowedOrigins:    allowedOrigins,
		AuthToken:         os.Getenv("WS_AUTH_TOKEN"),
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
		sess.Clients.Set(client, struct{}{})
	}

	hub.sessions.Set(sessionID, sess)

	fmt.Printf("Client connected: %s (%s)\n", client.clientType, client.sessionID)

	// Start client goroutines
	go client.writePump()
	go client.readPump()
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

	// Set up HTTP server
	http.HandleFunc("/ws", serveWs)
	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)

	server := &http.Server{
		Addr: addr,
	}

	// Handle graceful shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)

	go func() {
		<-stop
		log.Println("WebSocket server shutting down...")
		server.Close()
		os.Exit(0)
	}()

	// Start server
	mode := "development"
	if !config.IsDevelopment {
		mode = "production"
	}
	log.Printf("WebSocket server running in %s mode", mode)
	log.Printf("Server listening on ws://%s", addr)

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Error starting server: %v", err)
	}
}
