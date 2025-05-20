package main

import (
	"log"
	"net/http"
	"sync"
	"fmt"
	"os"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // For development only – restrict in production
	},
}

type Client struct {
	conn   *websocket.Conn
	callID string
}

type Message struct {
	Type   string `json:"type"`
	CallID string `json:"callId,omitempty"`
	Data   string `json:"data,omitempty"`
}

type Room struct {
	clients map[*websocket.Conn]bool
	offer   *Message
}

var (
	clients     = make(map[*websocket.Conn]*Client)
	idleClients = make(map[*websocket.Conn]bool)
	rooms       = make(map[string]*Room)
	clientsMu   sync.Mutex
	roomsMu     sync.Mutex
)

func sendError(conn *websocket.Conn, callID, message string) {
	err := conn.WriteJSON(Message{
		Type:   "error",
		CallID: callID,
		Data:   message,
	})
	if err != nil {
		log.Printf("Error sending error message to client %s: %v", conn.RemoteAddr(), err)
	}
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Error upgrading connection from %s: %v", r.RemoteAddr, err)
		return
	}

	// Add new client
	clientsMu.Lock()
	clients[ws] = &Client{conn: ws, callID: ""}
	idleClients[ws] = true
	clientsMu.Unlock()
	log.Printf("New client connected: %s", ws.RemoteAddr())

	defer func() {
		clientsMu.Lock()
		client := clients[ws]
		if client != nil && client.callID != "" {
			handleHangup(ws, client.callID)
		}
		delete(clients, ws)
		delete(idleClients, ws)
		clientsMu.Unlock()
		ws.Close()
		log.Printf("Client disconnected: %s", ws.RemoteAddr())
	}()

	for {
		var msg Message
		err := ws.ReadJSON(&msg)
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("Client %s closed connection", ws.RemoteAddr())
			} else {
				log.Printf("Error reading message from %s: %v", ws.RemoteAddr(), err)
			}
			break
		}

		// Validate callID for messages that require it
		if msg.Type != "join_call" && msg.CallID == "" {
			sendError(ws, "", "Missing callId in message")
			continue
		}

		log.Printf("Received message from %s: type=%s, callId=%s", ws.RemoteAddr(), msg.Type, msg.CallID)

		switch msg.Type {
		case "offer":
			handleOffer(ws, msg)
		case "answer":
			handleAnswer(ws, msg)
		case "ice-candidate":
			handleICECandidate(ws, msg)
		case "join_call":
			if msg.CallID == "" {
				sendError(ws, "", "Missing callId for join_call")
				continue
			}
			handleJoinCall(ws, msg)
		case "hangup":
			if msg.CallID == "" {
				sendError(ws, "", "Missing callId for hangup")
				continue
			}
			handleHangup(ws, msg.CallID)
		default:
			log.Printf("Unknown message type from %s: %s", ws.RemoteAddr(), msg.Type)
			sendError(ws, msg.CallID, fmt.Sprintf("Unknown message type: %s", msg.Type))
		}
	}
}

func handleOffer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	// Create room if it doesn't exist
	if _, exists := rooms[msg.CallID]; !exists {
		rooms[msg.CallID] = &Room{
			clients: make(map[*websocket.Conn]bool),
			offer:   &msg,
		}
		log.Printf("Created room for call %s", msg.CallID)
	} else {
		rooms[msg.CallID].offer = &msg
	}

	room := rooms[msg.CallID]

	// Limit room to 2 clients
	if len(room.clients) >= 2 {
		sendError(sender, msg.CallID, "Room is full")
		return
	}

	// Add sender to room
	room.clients[sender] = true
	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	delete(idleClients, sender)
	clientsMu.Unlock()

	log.Printf("Stored offer for call %s from %s", msg.CallID, sender.RemoteAddr())

	// Send offer to other clients in the room
	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending offer to %s: %v", client.RemoteAddr(), err)
				removeClient(client, msg.CallID)
			} else {
				log.Printf("Sent offer to %s for call %s", client.RemoteAddr(), msg.CallID)
			}
		}
	}
}

func handleAnswer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	if !exists {
		sendError(sender, msg.CallID, "Room not found")
		roomsMu.Unlock()
		return
	}

	// Limit room to 2 clients
	if len(room.clients) >= 2 && !room.clients[sender] {
		sendError(sender, msg.CallID, "Room is full")
		roomsMu.Unlock()
		return
	}

	room.clients[sender] = true
	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	delete(idleClients, sender)
	clientsMu.Unlock()

	// Send answer to other clients in the room
	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending answer to %s: %v", client.RemoteAddr(), err)
				removeClient(client, msg.CallID)
			} else {
				log.Printf("Sent answer to %s for call %s", client.RemoteAddr(), msg.CallID)
			}
		}
	}
	roomsMu.Unlock()
}

func handleICECandidate(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	if !exists {
		sendError(sender, msg.CallID, "Room not found")
		roomsMu.Unlock()
		return
	}

	// Send ICE candidate to other clients in the room
	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending ICE candidate to %s: %v", client.RemoteAddr(), err)
				removeClient(client, msg.CallID)
			} else {
				log.Printf("Sent ICE candidate to %s for call %s", client.RemoteAddr(), msg.CallID)
			}
		}
	}
	roomsMu.Unlock()
}

func handleJoinCall(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	if _, exists := rooms[msg.CallID]; !exists {
		rooms[msg.CallID] = &Room{
			clients: make(map[*websocket.Conn]bool),
			offer:   nil,
		}
		log.Printf("Created room for call %s", msg.CallID)
	}

	room := rooms[msg.CallID]

	// Limit room to 2 clients
	if len(room.clients) >= 2 {
		sendError(sender, msg.CallID, "Room is full")
		roomsMu.Unlock()
		return
	}

	room.clients[sender] = true
	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	delete(idleClients, sender)
	clientsMu.Unlock()

	log.Printf("Client %s joined call %s", sender.RemoteAddr(), msg.CallID)

	if room.offer != nil {
		if err := sender.WriteJSON(*room.offer); err != nil {
			log.Printf("Error sending stored offer to %s: %v", sender.RemoteAddr(), err)
			removeClient(sender, msg.CallID)
		} else {
			log.Printf("Sent stored offer to %s for call %s", sender.RemoteAddr(), msg.CallID)
		}
	} else {
		if err := sender.WriteJSON(Message{
			Type:   "call_joined",
			CallID: msg.CallID,
		}); err != nil {
			log.Printf("Error sending call_joined to %s: %v", sender.RemoteAddr(), err)
			removeClient(sender, msg.CallID)
		}
	}
	roomsMu.Unlock()
}

func handleHangup(sender *websocket.Conn, callID string) {
	roomsMu.Lock()
	room, exists := rooms[callID]
	if !exists {
		roomsMu.Unlock()
		return
	}

	// Notify other clients in the room
	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(Message{
				Type:   "peer_disconnected",
				CallID: callID,
			}); err != nil {
				log.Printf("Error sending hangup notification to %s: %v", client.RemoteAddr(), err)
				removeClient(client, callID)
			} else {
				log.Printf("Sent hangup notification to %s for call %s", client.RemoteAddr(), callID)
			}
		}
	}

	// Reset client states
	clientsMu.Lock()
	for client := range room.clients {
		if c, ok := clients[client]; ok {
			c.callID = ""
			idleClients[client] = true
		}
	}
	clientsMu.Unlock()

	// Delete the room
	delete(rooms, callID)
	log.Printf("Deleted room for call %s", callID)
	roomsMu.Unlock()
}

func removeClient(client *websocket.Conn, callID string) {
	roomsMu.Lock()
	if room, exists := rooms[callID]; exists {
		delete(room.clients, client)
		if len(room.clients) == 0 {
			delete(rooms, callID)
			log.Printf("Deleted empty room for call %s", callID)
		}
	}
	roomsMu.Unlock()

	clientsMu.Lock()
	if c, ok := clients[client]; ok {
		c.callID = ""
		idleClients[client] = true
	}
	clientsMu.Unlock()

	client.Close()
	log.Printf("Removed client %s from call %s", client.RemoteAddr(), callID)
}

func main() {
	// Verify static file directory exists
	if _, err := os.Stat("./client"); os.IsNotExist(err) {
		log.Println("Warning: ./client directory not found. Static file serving will fail.")
	}

	// Get port from environment variable or default to 8000
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	fs := http.FileServer(http.Dir("./client"))
	http.Handle("/", fs)
	http.HandleFunc("/ws", handleConnections)

	log.Printf("Starting HTTP server on :%s", port)
	err := http.ListenAndServe(":"+port, nil)
	if err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}
