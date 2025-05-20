package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"

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
	clients   = make(map[*websocket.Conn]*Client)
	rooms     = make(map[string]*Room)
	clientsMu sync.Mutex
	roomsMu   sync.Mutex
)

func sendError(conn *websocket.Conn, callID, message string) {
	msg := Message{Type: "error", CallID: callID, Data: message}
	if err := conn.WriteJSON(msg); err != nil {
		log.Printf("[WebSocket] Error sending error to %s: %v", conn.RemoteAddr(), err)
	} else {
		log.Printf("[WebSocket] Sent error to %s: %s", conn.RemoteAddr(), message)
	}
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WebSocket] Error upgrading connection from %s: %v", r.RemoteAddr, err)
		return
	}

	clientsMu.Lock()
	clients[ws] = &Client{conn: ws, callID: ""}
	clientsMu.Unlock()
	log.Printf("[WebSocket] Client connected: %s", ws.RemoteAddr())

	defer func() {
		cleanUpClient(ws)
		log.Printf("[WebSocket] Client disconnected: %s", ws.RemoteAddr())
	}()

	for {
		var msg Message
		err := ws.ReadJSON(&msg)
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("[WebSocket] Client %s closed connection normally", ws.RemoteAddr())
			} else if websocket.IsUnexpectedCloseError(err, websocket.CloseAbnormalClosure) {
				log.Printf("[WebSocket] Client %s closed connection abnormally: %v", ws.RemoteAddr(), err)
			} else {
				log.Printf("[WebSocket] Error reading from %s: %v", ws.RemoteAddr(), err)
			}
			break
		}

		if msg.Type != "join_call" && msg.CallID == "" {
			sendError(ws, "", "Missing callId")
			continue
		}

		log.Printf("[WebSocket] Received from %s: type=%s, callId=%s", ws.RemoteAddr(), msg.Type, msg.CallID)

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
	defer roomsMu.Unlock()

	if _, exists := rooms[msg.CallID]; !exists {
		rooms[msg.CallID] = &Room{
			clients: make(map[*websocket.Conn]bool),
			offer:   &msg,
		}
		log.Printf("[Room] Created room %s", msg.CallID)
	} else {
		rooms[msg.CallID].offer = &msg
	}

	room := rooms[msg.CallID]
	if len(room.clients) >= 2 {
		log.Printf("[Room] Room %s full, rejecting offer from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room is full")
		return
	}

	room.clients[sender] = true
	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = msg.CallID
	}
	clientsMu.Unlock()

	dataBytes, _ := json.Marshal(msg.Data)
	log.Printf("[Room] Stored offer for %s from %s: %s", msg.CallID, sender.RemoteAddr(), string(dataBytes))

	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("[WebSocket] Error sending offer to %s: %v", client.RemoteAddr(), err)
				go cleanUpClient(client)
			} else {
				log.Printf("[WebSocket] Sent offer to %s for %s", client.RemoteAddr(), msg.CallID)
			}
		}
	}
}

func handleAnswer(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[msg.CallID]
	if !exists {
		log.Printf("[Room] Room %s not found for answer from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room not found")
		return
	}

	if len(room.clients) >= 2 && !room.clients[sender] {
		log.Printf("[Room] Room %s full, rejecting answer from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room is full")
		return
	}

	room.clients[sender] = true
	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = msg.CallID
	}
	clientsMu.Unlock()

	dataBytes, _ := json.Marshal(msg.Data)
	log.Printf("[Room] Answer data for %s from %s: %s", msg.CallID, sender.RemoteAddr(), string(dataBytes))

	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("[WebSocket] Error sending answer to %s: %v", client.RemoteAddr(), err)
				go cleanUpClient(client)
			} else {
				log.Printf("[WebSocket] Sent answer to %s for %s", client.RemoteAddr(), msg.CallID)
			}
		}
	}
}

func handleICECandidate(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[msg.CallID]
	if !exists {
		log.Printf("[Room] Room %s not found for ICE candidate from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room not found")
		return
	}

	dataBytes, _ := json.Marshal(msg.Data)
	log.Printf("[Room] ICE candidate for %s from %s: %s", msg.CallID, sender.RemoteAddr(), string(dataBytes))

	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(msg); err != nil {
				log.Printf("[WebSocket] Error sending ICE candidate to %s: %v", client.RemoteAddr(), err)
				go cleanUpClient(client)
			} else {
				log.Printf("[WebSocket] Sent ICE candidate to %s for %s", client.RemoteAddr(), msg.CallID)
			}
		}
	}
}

func handleJoinCall(sender *websocket.Conn, msg Message) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	if _, exists := rooms[msg.CallID]; !exists {
		rooms[msg.CallID] = &Room{
			clients: make(map[*websocket.Conn]bool),
			offer:   nil,
		}
		log.Printf("[Room] Created room %s by %s", msg.CallID, sender.RemoteAddr())
	}

	room := rooms[msg.CallID]
	if room.clients[sender] {
		log.Printf("[Room] Client %s already in room %s, ignoring", sender.RemoteAddr(), msg.CallID)
		return
	}

	if len(room.clients) >= 2 {
		log.Printf("[Room] Room %s full, rejecting join from %s", msg.CallID, sender.RemoteAddr())
		sendError(sender, msg.CallID, "Room is full")
		return
	}

	room.clients[sender] = true
	clientsMu.Lock()
	if client, ok := clients[sender]; ok {
		client.callID = msg.CallID
	}
	clientsMu.Unlock()

	log.Printf("[Room] Client %s joined %s (size: %d)", sender.RemoteAddr(), msg.CallID, len(room.clients))

	if room.offer != nil {
		dataBytes, _ := json.Marshal(room.offer.Data)
		log.Printf("[Room] Sending stored offer for %s to %s: %s", msg.CallID, sender.RemoteAddr(), string(dataBytes))
		if err := sender.WriteJSON(*room.offer); err != nil {
			log.Printf("[WebSocket] Error sending offer to %s for %s: %v", sender.RemoteAddr(), msg.CallID, err)
			go cleanUpClient(sender)
		} else {
			log.Printf("[WebSocket] Sent offer to %s for %s", sender.RemoteAddr(), msg.CallID)
		}
	} else {
		if err := sender.WriteJSON(Message{Type: "call_joined", CallID: msg.CallID}); err != nil {
			log.Printf("[WebSocket] Error sending call_joined to %s for %s: %v", sender.RemoteAddr(), msg.CallID, err)
			go cleanUpClient(sender)
		} else {
			log.Printf("[WebSocket] Sent call_joined to %s for %s", sender.RemoteAddr(), msg.CallID)
		}
	}
}

func handleHangup(sender *websocket.Conn, callID string) {
	roomsMu.Lock()
	room, exists := rooms[callID]
	if !exists {
		log.Printf("[Room] Room %s not found for hangup by %s", callID, sender.RemoteAddr())
		roomsMu.Unlock()
		return
	}

	for client := range room.clients {
		if client != sender {
			if err := client.WriteJSON(Message{Type: "peer_disconnected", CallID: callID}); err != nil {
				log.Printf("[WebSocket] Error sending hangup to %s: %v", client.RemoteAddr(), err)
				go cleanUpClient(client)
			} else {
				log.Printf("[WebSocket] Sent hangup to %s for %s", client.RemoteAddr(), callID)
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
	log.Printf("[Room] Deleted room %s", callID)
	roomsMu.Unlock()
}

func cleanUpClient(client *websocket.Conn) {
	clientsMu.Lock()
	defer clientsMu.Unlock()

	clientData, exists := clients[client]
	if !exists {
		log.Printf("[WebSocket] Client %s not found in clients map", client.RemoteAddr())
		return
	}

	if clientData.callID != "" {
		roomsMu.Lock()
		if room, exists := rooms[clientData.callID]; exists {
			delete(room.clients, client)
			if len(room.clients) == 0 {
				delete(rooms, clientData.callID)
				log.Printf("[Room] Deleted empty room %s", clientData.callID)
			} else {
				for otherClient := range room.clients {
					if otherClient != client {
						if err := otherClient.WriteJSON(Message{Type: "peer_disconnected", CallID: clientData.callID}); err != nil {
							log.Printf("[WebSocket] Error sending peer_disconnected to %s: %v", otherClient.RemoteAddr(), err)
							go cleanUpClient(otherClient)
						} else {
							log.Printf("[WebSocket] Sent peer_disconnected to %s for %s", otherClient.RemoteAddr(), clientData.callID)
						}
					}
				}
			}
		}
		roomsMu.Unlock()
	}

	delete(clients, client)
	if err := client.Close(); err != nil && !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
		log.Printf("[WebSocket] Error closing client %s: %v", client.RemoteAddr(), err)
	}
}

func main() {
	if _, err := os.Stat("./client"); os.IsNotExist(err) {
		log.Println("[Server] Warning: ./client directory not found. Static files will not serve.")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	http.Handle("/", http.FileServer(http.Dir("./client")))
	http.HandleFunc("/ws", handleConnections)

	log.Printf("[Server] Starting server on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("[Server] Server failed: %v", err)
	}
}