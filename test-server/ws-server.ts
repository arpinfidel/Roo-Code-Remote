import { WebSocketServer, WebSocket } from "ws"
import { v4 as uuidv4 } from "uuid"
import { createServer } from "http"

interface ExtendedWebSocket extends WebSocket {
	isAlive: boolean
}

const PORT = 8080
const server = createServer()
const wss = new WebSocketServer({
	server,
	verifyClient: (info, callback) => {
		// Allow all origins for development
		callback(true)
	},
})

console.log(`WebSocket control server running on ws://localhost:${PORT}`)

wss.on("connection", (ws: WebSocket, req) => {
	const extWs = ws as ExtendedWebSocket
	const origin = req.headers.origin || ""

	// Set up heartbeat
	const heartbeat = () => {
		if (!extWs.isAlive) {
			extWs.terminate()
			return
		}
		extWs.isAlive = false
		extWs.ping()
	}

	extWs.isAlive = true
	extWs.on("pong", () => {
		extWs.isAlive = true
	})
	const interval = setInterval(heartbeat, 30000)

	// Add connection metadata to first message
	extWs.send(
		JSON.stringify({
			type: "connection-info",
			origin,
		}),
	)

	extWs.on("message", (data) => {
		try {
			const message = JSON.parse(data.toString())
			console.log("Received:", message)

			// Forward message to all other connected clients
			wss.clients.forEach((client) => {
				// console.log('Forwarding to client:', client);
				if (client !== ws && client.readyState === WebSocket.OPEN) {
					client.send(data.toString())
				}
			})

			// Send acknowledgement
			extWs.send(
				JSON.stringify({
					id: message.id,
					type: "acknowledge",
					status: "forwarded",
				}),
			)
		} catch (err) {
			console.error("Message parse error:", err)
		}
	})

	extWs.on("close", () => {
		clearInterval(interval)
		console.log("Client disconnected")
	})

	extWs.on("error", (err) => {
		console.error("WebSocket error:", err)
	})
})

server.listen(PORT, () => {
	console.log(`Server listening on port ${PORT}`)
})
