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
	Type   string      `json:"type"`
	CallID string      `json:"callId"`
	Data   interface{} `json:"data,omitempty"`
}

type Room struct {
	clients map[*websocket.Conn]bool
	offer   *Message
}

var (
	clients     = make(map[*websocket.Conn]*Client)
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
		log.Printf("Error sending error to %s: %v", conn.RemoteAddr(), err)
	}
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Error upgrading connection from %s: %v", r.RemoteAddr, err)
		return
	}

	clientsMu.Lock()
	clients[ws] = &Client{conn: ws, callID: ""}
	clientsMu.Unlock()
	log.Printf("Client connected: %s", ws.RemoteAddr())

	defer func() {
		clientsMu.Lock()
		client := clients[ws]
		if client.callID != "" {
			handleHangup(ws, client.callID)
		}
		delete(clients, ws)
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
				log.Printf("Error reading from %s: %v", ws.RemoteAddr(), err)
			}
			break
		}

		if msg.Type != "join_call" && msg.CallID == "" {
			sendError(ws, "", "Missing callId")
			continue
		}

		log.Printf("Received from %s: type=%s, callId=%s", ws.RemoteAddr(), msg.Type, msg.CallID)

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
			sendError(ws, msg.CallID, fmt.Sprintf("Unknown message type: %s", msg.Type))
		}
	}
}

func handleOffer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	if _, exists := rooms[msg.CallID]; !exists {
		rooms[msg.CallID] = &Room{
			clients: make(map[*websocket.Conn]bool),
			offer:   &msg,
		}
		log.Printf("Created room %s", msg.CallID)
	} else {
		rooms[msg.CallID].offer = &msg
	}

	room := rooms[msg.CallID]
	if len(room.clients) >= 2 {
		log.Printf("Room %s full, rejecting offer from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room is full")
		roomsMu.Unlock()
		return
	}

	room.clients[sender] = true
	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	clientsMu.Unlock()

	log.Printf("Stored offer for %s from %s", msg.CallID, sender.RemoteAddr())

	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending offer to %s: %v", client.RemoteAddr(), err)
				removeClient(client, msg.CallID)
			} else {
				log.Printf("Sent offer to %s for %s", client.RemoteAddr(), msg.CallID)
			}
		}
	}
	roomsMu.Unlock()
}

func handleAnswer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	if !exists {
		log.Printf("Room %s not found for answer from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room not found")
		roomsMu.Unlock()
		return
	}

	if len(room.clients) >= 2 && !room.clients[sender] {
		log.Printf("Room %s full, rejecting answer from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room is full")
		roomsMu.Unlock()
		return
	}

	room.clients[sender] = true
	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	clientsMu.Unlock()

	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending answer to %s: %v", client.RemoteAddr(), err)
				removeClient(client, msg.CallID)
			} else {
				log.Printf("Sent answer to %s for %s", client.RemoteAddr(), msg.CallID)
			}
		}
	}
	roomsMu.Unlock()
}

func handleICECandidate(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	room, exists := rooms[msg.CallID]
	if !exists {
		log.Printf("Room %s not found for ICE candidate from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room not found")
		roomsMu.Unlock()
		return
	}

	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("Error sending ICE candidate to %s: %v", client.RemoteAddr(), err)
				removeClient(client, msg.CallID)
			} else {
				log.Printf("Sent ICE candidate to %s for %s", client.RemoteAddr(), msg.CallID)
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
		log.Printf("Created room %s by %s", msg.CallID, sender.RemoteAddr())
	}

	room := rooms[msg.CallID]
	if room.clients[sender] {
		log.Printf("Client %s already in room %s, ignoring", sender.RemoteAddr(), msg.CallID)
		roomsMu.Unlock()
		return
	}

	if len(room.clients) >= 2 {
		log.Printf("Room %s full, rejecting join from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room is full")
		roomsMu.Unlock()
		return
	}

	room.clients[sender] = true
	clientsMu.Lock()
	clients[sender].callID = msg.CallID
	clientsMu.Unlock()

	log.Printf("Client %s joined %s (size: %d)", sender.RemoteAddr(), msg.CallID, len(room.clients))

	if room.offer != nil {
		if err := sender.WriteJSON(*room.offer); err != nil {
			log.Printf("Error sending offer to %s for %s: %v", sender.RemoteAddr(), msg.CallID, err)
			removeClient(sender, msg.CallID)
		} else {
			log.Printf("Sent offer to %s for %s", sender.RemoteAddr(), msg.CallID)
		}
	} else {
		if err := sender.WriteJSON(Message{Type: "call_joined", CallID: msg.CallID}); err != nil {
			log.Printf("Error sending call_joined to %s for %s: %v", sender.RemoteAddr(), msg.CallID, err)
			removeClient(sender, msg.CallID)
		} else {
			log.Printf("Sent call_joined to %s for %s", sender.RemoteAddr(), msg.CallID)
		}
	}
	roomsMu.Unlock()
}

func handleHangup(sender *websocket.Conn, callID string) {
	roomsMu.Lock()
	room, exists := rooms[callID]
	if !exists {
		log.Printf("Room %s not found for hangup by %s", callID, sender.RemoteAddr())
		roomsMu.Unlock()
		return
	}

	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(Message{Type: "peer_disconnected", CallID: callID}); err != nil {
				log.Printf("Error sending hangup to %s: %v", client.RemoteAddr(), err)
				removeClient(client, callID)
			} else {
				log.Printf("Sent hangup to %s for %s", client.RemoteAddr(), callID)
			}
		}
	}

	clientsMu.Lock()
	for client := range room.clients {
		if c, ok := clients[client]; ok {
			c.callID = ""
		}
	}
	clientsMu.Unlock()

	delete(rooms, callID)
	log.Printf("Deleted room %s", callID)
	roomsMu.Unlock()
}

func removeClient(client *websocket.Conn, callID string) {
	roomsMu.Lock()
	if room, exists := rooms[callID]; exists {
		delete(room.clients, client)
		if len(room.clients) == 0 {
			delete(rooms, callID)
			log.Printf("Deleted empty room %s", callID)
		}
	}
	roomsMu.Unlock()

	clientsMu.Lock()
	if c, ok := clients[client]; ok {
		c.callID = ""
	}
	clientsMu.Unlock()

	client.Close()
	log.Printf("Removed client %s from %s", client.RemoteAddr(), callID)
}

func main() {
	if _, err := os.Stat("./client"); os.IsNotExist(err) {
		log.Println("Warning: ./client directory not found. Static files will not serve.")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	http.Handle("/", http.FileServer(http.Dir("./client")))
	http.HandleFunc("/ws", handleConnections)

	log.Printf("Starting server on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}