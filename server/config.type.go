package main

// Config holds server configuration
type Config struct {
	Port              int
	Host              string
	IsDevelopment     bool
	HeartbeatInterval int
	AllowedOrigins    []string
	AuthToken         string
}
