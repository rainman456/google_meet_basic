//  const servers = {
//    iceServers: [
//      {
//        urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
//      },
//    ],
//    iceCandidatePoolSize: 10,
//  };

 const servers = {
     iceServers: [
       { urls: "stun:stun.l.google.com:19302",},
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
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
  console.log("Status:", message);
}

function createPeerConnection() {
  pc = new RTCPeerConnection(servers);

  pc.ontrack = (event) => {
    console.log("Received remote track:", event.track.kind);
    if (!remoteStream) remoteStream = new MediaStream();
    remoteStream.addTrack(event.track);
    remoteVideo.srcObject = remoteStream;
    updateStatus("Remote stream received");
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && socket?.readyState === WebSocket.OPEN && currentCallId) {
      console.log("Sending ICE candidate:", event.candidate);
      socket.send(
        JSON.stringify({
          type: "ice-candidate",
          callId: currentCallId,
          data: event.candidate,
        })
      );
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log("ICE connection state:", pc.iceConnectionState);
    if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
      updateStatus("Connection lost. Ending call.");
      resetCallState();
    }
  };

  pc.onsignalingstatechange = () => {
    console.log("Signaling state:", pc.signalingState);
  };

  return pc;
}

async function initializeWebSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (socket && socket.readyState === WebSocket.CONNECTING) return;

  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  updateStatus("Connecting to signaling server...");

  socket.onopen = () => {
    console.log("WebSocket connected");
    updateStatus("Connected to signaling server");
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
      console.log("Received message:", msg);
      if (!msg.type) throw new Error("Message missing type field");
    } catch (e) {
      console.error("Invalid WebSocket message:", event.data, e);
      updateStatus("Invalid message received");
      return;
    }

    if (msg.callId && !currentCallId) {
      currentCallId = msg.callId;
      callInput.value = currentCallId;
      console.log(`Initialized callId: ${currentCallId}`);
    } else if (msg.callId && msg.callId !== currentCallId) {
      console.warn(`Ignoring message for callId ${msg.callId}. Current: ${currentCallId}`);
      return;
    }

    try {
      switch (msg.type) {
        case "offer":
          if (!isCaller) {
            if (!pc || pc.signalingState === "closed") {
              pc = createPeerConnection();
              if (localStream) {
                localStream.getTracks().forEach((track) => {
                  pc.addTrack(track, localStream);
                  console.log("Added local track:", track.kind);
                });
              }
            }
            console.log("Setting remote offer");
            await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log("Sending answer");
            socket.send(
              JSON.stringify({
                type: "answer",
                callId: currentCallId,
                data: pc.localDescription,
              })
            );
            hangupButton.disabled = false;
            updateStatus("Answered call");
          }
          break;
        case "answer":
          if (isCaller) {
            console.log("Setting remote answer");
            await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
            hangupButton.disabled = false;
            updateStatus("Call connected");
          }
          break;
        case "ice-candidate":
          if (pc && pc.remoteDescription?.type) {
            console.log("Adding ICE candidate:", msg.data);
            await pc.addIceCandidate(new RTCIceCandidate(msg.data));
          } else {
            console.log("Queuing ICE candidate (no remote description yet)");
          }
          break;
        case "error":
          console.error("Signaling error:", msg.data);
          updateStatus(`Signaling error: ${msg.data}`);
          break;
        case "call_joined":
          if (!isCaller) {
            console.log("Joined call, waiting for offer");
            updateStatus("Joined call, waiting for offer");
          }
          break;
        case "peer_disconnected":
          updateStatus("Peer disconnected");
          resetCallState();
          break;
      }
    } catch (err) {
      console.error("Error processing message:", err, msg);
      updateStatus(`Error: ${err.message}`);
    }
  };

  socket.onclose = () => {
    console.log("WebSocket disconnected");
    updateStatus("Disconnected from signaling server");
    resetCallState();
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
    updateStatus("WebSocket error. Please try again.");
    resetCallState();
  };
}

webcamButton.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    console.log("Local stream acquired");
    remoteStream = new MediaStream();
    webcamVideo.srcObject = localStream;
    remoteVideo.srcObject = null;

    if (!pc || pc.signalingState === "closed") {
      pc = createPeerConnection();
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
        console.log("Added local track:", track.kind);
      });
    }

    callButton.disabled = false;
    answerButton.disabled = false;
    webcamButton.disabled = true;
    updateStatus("Webcam started");

    await initializeWebSocket();
  } catch (e) {
    console.error("Error accessing media devices:", e);
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

    pc = createPeerConnection();
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
      console.log("Added local track for call:", track.kind);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log("Sending offer");
    socket.send(
      JSON.stringify({
        type: "offer",
        callId: currentCallId,
        data: pc.localDescription,
      })
    );
    updateStatus("Call started, waiting for answer");
  } catch (e) {
    console.error("Error starting call:", e);
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
      console.log("Already joined call, ignoring");
      updateStatus("Already joined call");
      return;
    }

    await initializeWebSocket();

    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    console.log("Sending join_call for", currentCallId);
    socket.send(
      JSON.stringify({
        type: "join_call",
        callId: currentCallId,
      })
    );
    hasJoined = true;
    updateStatus("Joining call...");
  } catch (e) {
    console.error("Error answering call:", e);
    updateStatus(`Error: ${e.message}`);
    resetCallState();
  }
};

hangupButton.onclick = () => {
  if (socket?.readyState === WebSocket.OPEN && currentCallId) {
    console.log("Sending hangup");
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
  console.log("Resetting call state");
  if (pc) {
    pc.close();
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.onsignalingstatechange = null;
    pc = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.readyState === "live" && track.stop());
    localStream = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.readyState === "live" && track.stop());
    remoteStream = null;
  }

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close();
  }
  socket = null;

  currentCallId = null;
  isCaller = false;
  hasJoined = false;

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