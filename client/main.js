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
let pendingCandidates = [];

// HTML elements
const webcamButton = document.getElementById("webcamButton");
const webcamVideo = document.getElementById("webcamVideo");
const callButton = document.getElementById("callButton");
const callInput = document.getElementById("callInput");
const answerButton = document.getElementById("answerButton");
const remoteVideo = document.getElementById("remoteVideo");
const hangupButton = document.getElementById("hangupButton");

function createPeerConnection() {
  const peer = new RTCPeerConnection(servers);

  peer.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      event.streams[0].getTracks().forEach((track) => {
        if (remoteStream) {
          remoteStream.addTrack(track);
        }
      });
    }
  };

  peer.onicecandidate = (event) => {
    if (
      event.candidate &&
      socket &&
      socket.readyState === WebSocket.OPEN &&
      currentCallId
    ) {
      socket.send(
        JSON.stringify({
          type: "ice-candidate",
          callId: currentCallId,
          data: JSON.stringify(event.candidate),
        })
      );
    }
  };

  peer.oniceconnectionstatechange = () => {
    if (
      peer.iceConnectionState === "disconnected" ||
      peer.iceConnectionState === "failed"
    ) {
      alert("Connection lost. Ending call.");
      resetCallState();
    }
  };

  return peer;
}

async function initializeWebSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (socket && socket.readyState === WebSocket.CONNECTING) return;

  // Use a configurable WebSocket URL (update as needed)
  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${wsProtocol}://${location.host}/ws`);

  socket.onopen = () => {
    console.log("Connected to signaling server");
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
      if (!msg.type) throw new Error("Message missing type field");
    } catch (e) {
      console.error("Invalid WebSocket message:", event.data, e);
      return;
    }

    // Validate callId
    if (msg.callId && !currentCallId) {
      currentCallId = msg.callId;
      callInput.value = currentCallId;
      console.log(`Initialized currentCallId: ${currentCallId}`);
    } else if (msg.callId && msg.callId !== currentCallId) {
      console.warn(
        `Ignoring message for callId ${msg.callId}. Current: ${currentCallId}`
      );
      return;
    }

    try {
      if (msg.type === "offer" && !isCaller) {
        if (!pc || pc.signalingState === "closed") {
          pc = createPeerConnection();
          if (localStream) {
            localStream.getTracks().forEach((track) =>
              pc.addTrack(track, localStream)
            );
          }
        }

        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.send(
          JSON.stringify({
            type: "answer",
            callId: currentCallId,
            data: JSON.stringify(pc.localDescription),
          })
        );

        for (const candidate of pendingCandidates) {
          await pc.addIceCandidate(candidate);
        }
        pendingCandidates = [];

        hangupButton.disabled = false;
      } else if (msg.type === "answer" && isCaller) {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(msg.data)));
        hangupButton.disabled = false;
      } else if (msg.type === "ice-candidate") {
        const candidate = new RTCIceCandidate(JSON.parse(msg.data));
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(candidate);
        } else {
          pendingCandidates.push(candidate);
        }
      } else if (msg.type === "error") {
        console.error("Signaling error:", msg.message);
        alert(`Signaling error: ${msg.message}`);
      } else if (msg.type === "call_joined" && !isCaller) {
        console.log("Successfully joined call. Waiting for offer.");
      } else if (msg.type === "peer_disconnected") {
        alert("The other user has disconnected.");
        resetCallState();
      }
    } catch (err) {
      console.error("Error processing WebSocket message:", err, msg);
    }
  };

  socket.onclose = () => {
    console.log("Disconnected from signaling server");
    resetCallState();
  };

  socket.onerror = (error) => {
    console.error("WebSocket Error:", error);
    alert("Failed to connect to signaling server. Please try again.");
    resetCallState();
  };
}

webcamButton.onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    remoteStream = new MediaStream();

    if (!pc || pc.signalingState === "closed") {
      pc = createPeerConnection();
    }

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    webcamVideo.srcObject = localStream;
    remoteVideo.srcObject = remoteStream;

    callButton.disabled = false;
    answerButton.disabled = false;
    webcamButton.disabled = true;

    await initializeWebSocket();
  } catch (e) {
    console.error("Error accessing media devices:", e);
    alert(`Error accessing media devices: ${e.message}`);
    callButton.disabled = true;
    answerButton.disabled = true;
    webcamButton.disabled = false;
  }
};

callButton.onclick = async () => {
  try {
    if (!localStream) await webcamButton.onclick();

    isCaller = true;
    currentCallId = "call_" + Math.random().toString(36).substr(2, 9);
    callInput.value = currentCallId;
    callInput.readOnly = true;

    await initializeWebSocket();

    if (socket.readyState === WebSocket.OPEN) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.send(
        JSON.stringify({
          type: "offer",
          callId: currentCallId,
          data: JSON.stringify(pc.localDescription),
        })
      );
    } else {
      throw new Error("WebSocket not connected");
    }
  } catch (e) {
    console.error("Error initiating call:", e);
    alert("Failed to start call. Please try again.");
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
      alert("Please enter a Call ID to answer.");
      callInput.readOnly = false;
      return;
    }

    await initializeWebSocket();

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "join_call",
          callId: currentCallId,
        })
      );
    } else {
      throw new Error("WebSocket not connected");
    }
  } catch (e) {
    console.error("Error answering call:", e);
    alert("Failed to answer call. Please try again.");
    resetCallState();
  }
};

hangupButton.onclick = () => {
  if (socket && socket.readyState === WebSocket.OPEN && currentCallId) {
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
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.close();
    pc = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      if (track.readyState === "live") track.stop();
    });
    localStream = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => {
      if (track.readyState === "live") track.stop();
    });
    remoteStream = null;
  }

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close();
  }
  socket = null;

  currentCallId = null;
  isCaller = false;
  pendingCandidates = [];

  callInput.value = "";
  callInput.readOnly = false;

  webcamVideo.srcObject = null;
  remoteVideo.srcObject = null;

  callButton.disabled = true;
  answerButton.disabled = true;
  hangupButton.disabled = true;
  webcamButton.disabled = false;
}

// Initial state
callButton.disabled = true;
answerButton.disabled = true;
hangupButton.disabled = true;
