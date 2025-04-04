package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
)

// Config holds server configuration
type Config struct {
	Port              int
	Host              string
	IsDevelopment     bool
	HeartbeatInterval int
	AllowedOrigins    []string
	AuthToken         string
}

// MessageType represents the type of WebSocket message
type MessageType string

const (
	ConnectionInfo MessageType = "connection-info"
	ClientIdentify MessageType = "client-identify"
	Acknowledge    MessageType = "acknowledge"
	Error          MessageType = "error"
	Command        MessageType = "command"
	Response       MessageType = "response"
	Event          MessageType = "event"
	VSCodeMessage  MessageType = "vscode-message"
	VSCodeEvent    MessageType = "vscode-event"
)

// ClientType represents the type of client
type ClientType string

const (
	WebUI     ClientType = "webui"
	Extension ClientType = "extension"
)

// WebSocketMessage represents a message sent over WebSocket
type WebSocketMessage struct {
	ID         string      `json:"id,omitempty"`
	Type       MessageType `json:"type"`
	Action     string      `json:"action,omitempty"`
	Payload    interface{} `json:"payload,omitempty"`
	Status     string      `json:"status,omitempty"`
	Error      string      `json:"error,omitempty"`
	ClientType ClientType  `json:"clientType,omitempty"`
	ClientID   string      `json:"clientId,omitempty"`
	Timestamp  int64       `json:"timestamp,omitempty"`
	Origin     string      `json:"origin,omitempty"`
}

// ClientIdentifyMessage represents a client identification message
type ClientIdentifyMessage struct {
	WebSocketMessage
	ClientType ClientType `json:"clientType"`
	SessionID  string     `json:"sessionId"`
}

// Client represents a connected WebSocket client
type Client struct {
	conn       *websocket.Conn
	isAlive    bool
	clientType ClientType
	clientID   string
	mu         sync.Mutex
}

// Hub maintains the set of active clients
type Hub struct {
	clients    map[*Client]bool
	register   chan *Client
	unregister chan *Client
	broadcast  chan *WebSocketMessage
	mu         sync.Mutex
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
		clients:    make(map[*Client]bool),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan *WebSocketMessage),
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
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				client.conn.Close()
			}
			h.mu.Unlock()
		case message := <-h.broadcast:
			h.mu.Lock()
			for client := range h.clients {
				client.sendMessage(message)
			}
			h.mu.Unlock()
		}
	}
}

// sendMessage sends a message to the client
func (c *Client) sendMessage(msg *WebSocketMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := c.conn.WriteJSON(msg); err != nil {
		log.Printf("Error sending message to client %s: %v", c.clientID, err)
	}
}

// writePump pumps messages from the hub to the websocket connection
func (c *Client) writePump() {
	ticker := time.NewTicker(time.Duration(config.HeartbeatInterval) * time.Millisecond)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case <-ticker.C:
			c.mu.Lock()
			if !c.isAlive {
				log.Printf("Terminating inactive client %s", c.clientID)
				c.mu.Unlock()
				return
			}
			c.isAlive = false
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.mu.Unlock()
				return
			}
			c.mu.Unlock()
		}
	}
}

// readPump pumps messages from the websocket connection to the hub
func (c *Client) readPump() {
	defer func() {
		hub.unregister <- c
		log.Printf("Client disconnected: %s (%s)", c.clientType, c.clientID)
		c.conn.Close()
	}()

	// Set up ping handler
	c.conn.SetPongHandler(func(string) error {
		c.mu.Lock()
		c.isAlive = true
		c.mu.Unlock()
		return nil
	})

	// Send initial connection info
	connectionInfo := WebSocketMessage{
		ID:        uuid.New().String(),
		Type:      ConnectionInfo,
		Origin:    c.conn.RemoteAddr().String(),
		Timestamp: time.Now().UnixMilli(),
		ClientID:  c.clientID,
	}
	c.sendMessage(&connectionInfo)

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error for client %s: %v", c.clientID, err)
			}
			break
		}

		c.handleMessage(message)
	}
}

// handleMessage processes incoming messages
func (c *Client) handleMessage(data []byte) {
	var msg WebSocketMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("Message parse error: %v", err)
		errorMsg := WebSocketMessage{
			ID:        uuid.New().String(),
			Type:      Error,
			Error:     "Failed to parse message",
			Timestamp: time.Now().UnixMilli(),
		}
		c.sendMessage(&errorMsg)
		return
	}

	// Handle client identification
	if msg.Type == ClientIdentify {
		var identifyMsg ClientIdentifyMessage
		if err := json.Unmarshal(data, &identifyMsg); err != nil {
			log.Printf("Client identify parse error: %v", err)
			return
		}

		c.mu.Lock()
		c.clientType = identifyMsg.ClientType
		c.mu.Unlock()

		log.Printf("Client identified as %s with ID %s", c.clientType, c.clientID)

		// Send acknowledgement
		ackMsg := WebSocketMessage{
			ID:         msg.ID,
			Type:       Acknowledge,
			Status:     "identified",
			Timestamp:  time.Now().UnixMilli(),
			ClientID:   c.clientID,
			ClientType: c.clientType,
		}
		c.sendMessage(&ackMsg)
		return
	}

	// Add timestamp and client info to message
	enrichedMsg := msg
	enrichedMsg.Timestamp = time.Now().UnixMilli()
	enrichedMsg.ClientID = c.clientID
	enrichedMsg.ClientType = c.clientType

	log.Printf("Received from %s client: %s", c.clientType, msg.Type)

	// Forward message to all other connected clients
	hub.mu.Lock()
	for client := range hub.clients {
		if client != c {
			client.sendMessage(&enrichedMsg)
		}
	}
	hub.mu.Unlock()

	// Send acknowledgement
	ackMsg := WebSocketMessage{
		ID:        msg.ID,
		Type:      Acknowledge,
		Status:    "forwarded",
		Timestamp: time.Now().UnixMilli(),
	}
	c.sendMessage(&ackMsg)
}

// serveWs handles websocket requests from clients
func serveWs(w http.ResponseWriter, r *http.Request) {
	// Verify token in production (origins are always allowed)
	if !config.IsDevelopment {
		origin := r.Header.Get("Origin")

		// Check auth token if configured
		if config.AuthToken != "" {
			authHeader := r.Header.Get("Authorization")
			requestToken := ""
			if strings.HasPrefix(authHeader, "Bearer ") {
				requestToken = strings.TrimPrefix(authHeader, "Bearer ")
			}

			if requestToken != config.AuthToken {
				log.Printf("Authentication failed from %s", origin)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Error upgrading connection:", err)
		return
	}

	client := &Client{
		conn:       conn,
		isAlive:    true,
		clientID:   uuid.New().String(),
		clientType: "", // Will be set when client identifies itself
	}

	hub.register <- client

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
	http.HandleFunc("/", serveWs)
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
