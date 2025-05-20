const servers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.relay.metered.ca:80" },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: "e6166b934e60840d935743c7",
      credential: "uNdKAwfH/TDOs6EP",
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: "e6166b934e60840d935743c7",
      credential: "uNdKAwfH/TDOs6EP",
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: "e6166b934e60840d935743c7",
      credential: "uNdKAwfH/TDOs6EP",
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: "e6166b934e60840d935743c7",
      credential: "uNdKAwfH/TDOs6EP",
    },
  ],
  iceCandidatePoolSize: 10,
};

let pc = null;
let localStream = null;
let remoteStream = null;
let socket = null;
let currentCallId = null;
let isCaller = false;
let hasJoined = false;
let pendingCandidates = [];

// HTML elements
const webcamButton = document.getElementById("webcamButton");
const webcamVideo = document.getElementById("webcamVideo");
const callButton = document.getElementById("callButton");
const callInput = document.getElementById("callInput");
const answerButton = document.getElementById("answerButton");
const remoteVideo = document.getElementById("remoteVideo");
const hangupButton = document.getElementById("hangupButton");
const status = document.getElementById("status");

function updateStatus(message) {
  status.textContent = message;
  console.log(`[Status] ${message}`);
}

function createPeerConnection() {
  pc = new RTCPeerConnection(servers);

  pc.ontrack = (event) => {
    console.log(`[WebRTC] Received remote track: kind=${event.track.kind}, id=${event.track.id}, enabled=${event.track.enabled}`);
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
      console.log("[WebRTC] Initialized remote stream");
    }
    remoteStream.addTrack(event.track);
    console.log(`[WebRTC] Added track to remote stream: ${event.track.kind}`);
    updateStatus("Remote stream received");
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && socket?.readyState === WebSocket.OPEN && currentCallId) {
      console.log(`[WebRTC] Sending ICE candidate: ${JSON.stringify(event.candidate)}`);
      socket.send(
        JSON.stringify({
          type: "ice-candidate",
          callId: currentCallId,
          data: event.candidate,
        })
      );
    } else if (!event.candidate) {
      console.log("[WebRTC] ICE candidate gathering complete");
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[WebRTC] ICE connection state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "disconnected") {
      updateStatus("Connection temporarily lost, attempting to reconnect...");
    } else if (pc.iceConnectionState === "failed") {
      console.error("[WebRTC] ICE connection failed");
      updateStatus("Connection failed. Ending call.");
      resetCallState();
    } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      updateStatus("Call connected");
    }
  };

  pc.onicegatheringstatechange = () => {
    console.log(`[WebRTC] ICE gathering state: ${pc.iceGatheringState}`);
  };

  pc.onsignalingstatechange = () => {
    console.log(`[WebRTC] Signaling state: ${pc.signalingState}`);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Connection state: ${pc.connectionState}`);
    if (pc.connectionState === "failed") {
      console.error("[WebRTC] Connection state failed");
      updateStatus("Connection failed. Ending call.");
      resetCallState();
    }
  };

  return pc;
}

async function initializeWebSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.log("[WebSocket] Already connected");
    return;
  }
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    console.log("[WebSocket] Connection in progress");
    return;
  }

  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  console.log("[WebSocket] Connecting...");
  updateStatus("Connecting to signaling server...");

  socket.onopen = () => {
    console.log("[WebSocket] Connected");
    updateStatus("Connected to signaling server");
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
      console.log(`[WebSocket] Received: ${JSON.stringify(msg)}`);
      if (!msg.type) throw new Error("Message missing type field");
    } catch (e) {
      console.error(`[WebSocket] Invalid message: ${event.data}`, e);
      updateStatus("Received invalid message");
      return;
    }

    if (msg.callId && !currentCallId) {
      currentCallId = msg.callId;
      callInput.value = currentCallId;
      console.log(`[WebSocket] Set callId: ${currentCallId}`);
    } else if (msg.callId && msg.callId !== currentCallId) {
      console.warn(`[WebSocket] Ignoring message for callId ${msg.callId}. Current: ${currentCallId}`);
      return;
    }

    try {
      switch (msg.type) {
        case "offer":
          if (!isCaller) {
            if (!pc || pc.signalingState === "closed" || pc.signalingState === "stable") {
              pc = createPeerConnection();
              if (localStream) {
                localStream.getTracks().forEach((track) => {
                  pc.addTrack(track, localStream);
                  console.log(`[WebRTC] Added local track: kind=${track.kind}, id=${track.id}`);
                });
              }
            }
            if (pc.signalingState !== "stable") {
              console.warn("[WebRTC] Ignoring offer in non-stable state:", pc.signalingState);
              return;
            }
            console.log("[WebRTC] Setting remote offer");
            await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log("[WebRTC] Sending answer");
            socket.send(
              JSON.stringify({
                type: "answer",
                callId: currentCallId,
                data: pc.localDescription,
              })
            );
            // Apply any pending ICE candidates
            for (const candidate of pendingCandidates) {
              console.log(`[WebRTC] Applying queued ICE candidate: ${JSON.stringify(candidate)}`);
              await pc.addIceCandidate(candidate);
            }
            pendingCandidates = [];
            hangupButton.disabled = false;
            updateStatus("Answered call");
          }
          break;
        case "answer":
          if (isCaller && pc && pc.signalingState === "have-local-offer") {
            console.log("[WebRTC] Setting remote answer");
            await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
            // Apply any pending ICE candidates
            for (const candidate of pendingCandidates) {
              console.log(`[WebRTC] Applying queued ICE candidate: ${JSON.stringify(candidate)}`);
              await pc.addIceCandidate(candidate);
            }
            pendingCandidates = [];
            hangupButton.disabled = false;
            updateStatus("Call connected");
          } else {
            console.warn("[WebRTC] Ignoring answer: not caller or wrong state", {
              isCaller,
              signalingState: pc?.signalingState,
            });
          }
          break;
        case "ice-candidate":
          if (pc && pc.remoteDescription?.type) {
            console.log(`[WebRTC] Adding ICE candidate: ${JSON.stringify(msg.data)}`);
            await pc.addIceCandidate(new RTCIceCandidate(msg.data));
          } else {
            console.log("[WebRTC] Queuing ICE candidate");
            pendingCandidates.push(new RTCIceCandidate(msg.data));
          }
          break;
        case "error":
          console.error(`[Signaling] Error: ${msg.data}`);
          updateStatus(`Signaling error: ${msg.data}`);
          resetCallState();
          break;
        case "call_joined":
          if (!isCaller) {
            console.log("[Signaling] Joined call, waiting for offer");
            updateStatus("Joined call, waiting for offer");
          }
          break;
        case "peer_disconnected":
          console.log("[Signaling] Peer disconnected");
          updateStatus("Peer disconnected");
          resetCallState();
          break;
      }
    } catch (err) {
      console.error(`[WebSocket] Error processing message: ${err.message}`, msg);
      updateStatus(`Error: ${err.message}`);
    }
  };

  socket.onclose = () => {
    console.log("[WebSocket] Disconnected");
    updateStatus("Disconnected from signaling server");
    resetCallState();
  };

  socket.onerror = (error) => {
    console.error("[WebSocket] Error:", error);
    updateStatus("WebSocket error. Please try again.");
    resetCallState();
  };
}

webcamButton.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    console.log("[Media] Local stream acquired with tracks:", localStream.getTracks().map(t => `${t.kind}:${t.id}`));
    remoteStream = new MediaStream();
    webcamVideo.srcObject = localStream;
    remoteVideo.srcObject = remoteStream;

    if (!pc || pc.signalingState === "closed") {
      pc = createPeerConnection();
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
        console.log(`[WebRTC] Added local track: kind=${track.kind}, id=${track.id}`);
      });
    }

    callButton.disabled = false;
    answerButton.disabled = false;
    webcamButton.disabled = true;
    updateStatus("Webcam started");

    await initializeWebSocket();
  } catch (e) {
    console.error("[Media] Error accessing media devices:", e);
    updateStatus(`Error: ${e.message}`);
    callButton.disabled = true;
    answerButton.disabled = true;
    webcamButton.disabled = false;
  }
};

callButton.onclick = async () => {
  try {
    if (!localStream) await webcamButton.onclick();

    isCaller = true;
    hasJoined = false;
    currentCallId = "call_" + Math.random().toString(36).slice(2, 11);
    callInput.value = currentCallId;
    callInput.readOnly = true;

    await initializeWebSocket();

    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    if (!pc || pc.signalingState === "closed") {
      pc = createPeerConnection();
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
        console.log(`[WebRTC] Added local track for call: kind=${track.kind}, id=${track.id}`);
      });
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log("[WebRTC] Sending offer:", offer);
    socket.send(
      JSON.stringify({
        type: "offer",
        callId: currentCallId,
        data: offer,
      })
    );
    updateStatus("Call started, waiting for answer");
  } catch (e) {
    console.error("[Call] Error starting call:", e);
    updateStatus(`Error: ${e.message}`);
    resetCallState();
  }
};

answerButton.onclick = async () => {
  try {
    if (!localStream) await webcamButton.onclick();

    isCaller = false;
    currentCallId = callInput.value.trim();
    callInput.readOnly = true;

    if (!currentCallId) {
      updateStatus("Please enter a Call ID");
      callInput.readOnly = false;
      return;
    }

    if (hasJoined) {
      console.log("[Call] Already joined call, ignoring");
      updateStatus("Already joined call");
      return;
    }

    await initializeWebSocket();

    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    console.log("[Call] Sending join_call for", currentCallId);
    socket.send(
      JSON.stringify({
        type: "join_call",
        callId: currentCallId,
      })
    );
    hasJoined = true;
    updateStatus("Joining call...");
  } catch (e) {
    console.error("[Call] Error answering call:", e);
    updateStatus(`Error: ${e.message}`);
    resetCallState();
  }
};

hangupButton.onclick = () => {
  if (socket?.readyState === WebSocket.OPEN && currentCallId) {
    console.log("[Call] Sending hangup");
    socket.send(
      JSON.stringify({
        type: "hangup",
        callId: currentCallId,
      })
    );
  }
  resetCallState();
};

function resetCallState() {
  console.log("[State] Resetting call state");
  if (pc) {
    pc.close();
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.onicegatheringstatechange = null;
    pc.onsignalingstatechange = null;
    pc.onconnectionstatechange = null;
    pc = null;
    console.log("[WebRTC] Peer connection closed");
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      if (track.readyState === "live") {
        track.stop();
        console.log(`[Media] Stopped local track: kind=${track.kind}, id=${track.id}`);
      }
    });
    localStream = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => {
      if (track.readyState === "live") {
        track.stop();
        console.log(`[Media] Stopped remote track: kind=${track.kind}, id=${track.id}`);
      }
    });
    remoteStream = null;
  }

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close();
    console.log("[WebSocket] Closed connection");
  }
  socket = null;

  currentCallId = null;
  isCaller = false;
  hasJoined = false;
  pendingCandidates = [];

  callInput.value = "";
  callInput.readOnly = false;
  webcamVideo.srcObject = null;
  remoteVideo.srcObject = null;

  callButton.disabled = true;
  answerButton.disabled = true;
  hangupButton.disabled = true;
  webcamButton.disabled = false;

  updateStatus("Call ended");
}

// Initial state
callButton.disabled = true;
answerButton.disabled = true;
hangupButton.disabled = true;
updateStatus("Ready");