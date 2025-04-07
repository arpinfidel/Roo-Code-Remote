package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
	"google.golang.org/api/option"

	"github.com/arpinfidel/Roo-Code-Remote/server/syncmap"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
)

type Session struct {
	Host    *Client
	Clients *syncmap.SyncMap[*Client, struct{}]
}

// Hub maintains the set of active clients
type Hub struct {
	sessions  *syncmap.SyncMap[string, Session]
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
	firebaseAuth *auth.Client
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

func initializeFirebase() error {
	opt := option.WithCredentialsFile("./files/roo-code-remote-firebase-adminsdk.json")
	app, err := firebase.NewApp(context.Background(), nil, opt)
	if err != nil {
		return fmt.Errorf("error initializing Firebase app: %v", err)
	}

	firebaseAuth, err = app.Auth(context.Background())
	if err != nil {
		return fmt.Errorf("error getting Firebase auth client: %v", err)
	}

	return nil
}

func main() {
	// Load configuration
	config = loadConfig()

	// Initialize Firebase
	if err := initializeFirebase(); err != nil {
		log.Fatalf("Failed to initialize Firebase: %v", err)
	}

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
	// mux.HandleFunc("/ws", serveWs)
	mux.HandleFunc("/ws", AuthMiddleware(serveWs))
	mux.HandleFunc("/api/sessions", AuthMiddleware(serveApiSessions))
	mux.HandleFunc("/api/firebase-token", AuthMiddleware(serveFirebaseToken))

	// --- Handle other requests ---
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// In development, proxy to React dev server
		if config.IsDevelopment && reactProxy != nil {
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
