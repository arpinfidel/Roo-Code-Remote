package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// MessageType represents the type of WebSocket message
type MessageType string

const (
	ConnectionInfo  MessageType = "connection-info"
	Acknowledge     MessageType = "acknowledge"
	Error           MessageType = "error"
	Command         MessageType = "command"
	Response        MessageType = "response"
	Event           MessageType = "event"
	VSCodeMessage   MessageType = "vscode-message"
	VSCodeEvent     MessageType = "vscode-event"
	ClientConnected MessageType = "client-connected"
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
	SessionID  string      `json:"sessionId,omitempty"`
	Type       MessageType `json:"type"`
	Action     string      `json:"action,omitempty"`
	Payload    any         `json:"payload,omitempty"`
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
	sessionID  string
	conn       *websocket.Conn
	isAlive    bool
	clientType ClientType
	clientID   string
	mu         sync.Mutex
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
		s, ok := hub.sessions.Get(c.sessionID)
		if !ok {
			return
		}
		if c.clientType == Extension {
			s.Clients.Range(func(c *Client, value struct{}) bool {
				c.conn.Close()
				return true
			})
			hub.sessions.Delete(c.sessionID)
		} else {
			if s.Clients != nil {
				s.Clients.Delete(c)
			}
		}
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

	// Add timestamp and client info to message
	enrichedMsg := msg
	enrichedMsg.Timestamp = time.Now().UnixMilli()
	enrichedMsg.ClientID = c.clientID
	enrichedMsg.ClientType = c.clientType
	enrichedMsg.SessionID = c.sessionID

	log.Printf("Received from %s (%s) client: %s", c.clientType, c.sessionID, msg.Type)

	// Forward message to all other connected clients
	s, _ := hub.sessions.Get(c.sessionID)
	targets := []*Client{}
	if c.clientType == Extension {
		s.Clients.Range(func(client *Client, _ struct{}) bool {
			targets = append(targets, client)
			return true
		})
	} else if s.Host != nil {
		targets = []*Client{s.Host}
	}

	for _, client := range targets {
		client.sendMessage(&enrichedMsg)
	}

	// Send acknowledgement
	ackMsg := WebSocketMessage{
		ID:        msg.ID,
		Type:      Acknowledge,
		Status:    "forwarded",
		Timestamp: time.Now().UnixMilli(),
	}
	c.sendMessage(&ackMsg)
}
