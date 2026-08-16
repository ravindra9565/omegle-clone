// Configuration - High Availability STUN & TURN Relay Servers
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelay',
    credential: 'openrelay'
  }
];

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  sampleSize: 16,
  latency: 0.005
};

const VIDEO_CONSTRAINTS = {
  width: { ideal: 640, max: 1280 },
  height: { ideal: 480, max: 720 },
  frameRate: { ideal: 30, min: 24, max: 30 },
  facingMode: 'user'
};

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat';

// State
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let peerConnectionInitPromise = null;
let socket = null;
let sessionId = null;
let peerId = null;
let isMatching = false;
let isConnected = false;
let isMuted = false;
let isCamOff = false;
let pendingCandidates = [];
let frameStreamTimer = null;
let audioCtx = null;

// DOM Elements
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remoteAudio = document.getElementById('remoteAudio');
const remoteCanvas = document.getElementById('remoteCanvas');

const localOverlay = document.getElementById('localOverlay');
const strangerPlaceholder = document.getElementById('strangerPlaceholder');
const matchStatusText = document.getElementById('matchStatusText');
const strangerBadge = document.getElementById('strangerBadge');
const onlineCount = document.getElementById('onlineCount');
const micStatusIndicator = document.getElementById('micStatusIndicator');

const btnStartMatch = document.getElementById('btnStartMatch');
const startBtnText = document.getElementById('startBtnText');
const btnNewChat = document.getElementById('btnNewChat');
const btnToggleMic = document.getElementById('btnToggleMic');
const btnToggleCam = document.getElementById('btnToggleCam');

const messagesContainer = document.getElementById('messagesContainer');
const messageInput = document.getElementById('messageInput');
const btnSendMessage = document.getElementById('btnSendMessage');
const typingIndicator = document.getElementById('typingIndicator');

const btnPreferences = document.getElementById('btnPreferences');
const prefModal = document.getElementById('prefModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const btnFreeMatch = document.getElementById('btnFreeMatch');
const btnStore = document.getElementById('btnStore');
const profileAvatar = document.getElementById('profileAvatar');
const authModal = document.getElementById('authModal');
const authForm = document.getElementById('authForm');
const authStatus = document.getElementById('authStatus');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const fullName = document.getElementById('fullName');
const nameField = document.getElementById('nameField');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const btnLogout = document.getElementById('btnLogout');
const authProfileBox = document.getElementById('authProfileBox');
const profileNameText = document.getElementById('profileNameText');
const profileEmailText = document.getElementById('profileEmailText');
const profileAvatarLarge = document.getElementById('profileAvatarLarge');
const authTabs = document.querySelectorAll('.auth-tab');

let currentUser = null;
let authMode = 'login';

// Hidden canvas for frame capture fallback
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d');
captureCanvas.width = 360;
captureCanvas.height = 270;

async function fetchOnlineUsers() {
  try {
    const response = await fetch('/api/online');
    const data = await response.json();
    const count = Number(data?.online || 0);
    onlineCount.textContent = count.toLocaleString();
  } catch (err) {
    onlineCount.textContent = '0';
  }
}

setInterval(fetchOnlineUsers, 10000);
fetchOnlineUsers();

// Fallback animated stream if camera is busy
function createFallbackVideoStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  
  let frame = 0;
  function draw() {
    frame++;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 640, 480);

    const radius = 65 + Math.sin(frame * 0.08) * 12;
    ctx.beginPath();
    ctx.arc(320, 200, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#3b82f6';
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 40px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('👤', 320, 214);

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 18px Inter, sans-serif';
    ctx.fillText('Live Camera', 320, 310);
    ctx.font = '14px Inter, sans-serif';
    ctx.fillText(new Date().toLocaleTimeString(), 320, 340);

    requestAnimationFrame(draw);
  }
  draw();

  return canvas.captureStream(25);
}

function applyAudioTrackSettings(track) {
  if (!track || typeof track.applyConstraints !== 'function') return;

  const constraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };

  track.applyConstraints(constraints).catch(() => {});
}

// 1. Initialize Local Camera and Microphone
async function initLocalCamera() {
  if (localStream && localStream.getAudioTracks().length > 0 && localStream.getVideoTracks().length > 0) {
    return localStream;
  }
  
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: VIDEO_CONSTRAINTS,
        audio: AUDIO_CONSTRAINTS
      });
      localStream.getAudioTracks().forEach(track => {
        track.enabled = true;
        applyAudioTrackSettings(track);
      });
      localVideo.srcObject = localStream;
      localVideo.muted = true; // Local preview is muted
      localVideo.playsInline = true;
      localVideo.play().catch(() => {});
      localOverlay.style.display = 'none';
      updateMicIndicator(true);
      return localStream;
    } catch (e1) {
      console.warn('Combined getUserMedia failed, trying individual calls:', e1);
      
      let videoStream = null;
      let audioStream = null;

      try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      } catch (ev) {
        console.warn('Video only failed:', ev);
      }

      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      } catch (ea) {
        console.warn('Audio only failed:', ea);
      }

      if (videoStream && audioStream) {
        localStream = new MediaStream([...videoStream.getVideoTracks(), ...audioStream.getAudioTracks()]);
      } else if (videoStream) {
        localStream = videoStream;
      } else if (audioStream) {
        localStream = audioStream;
      }

      if (localStream) {
        localStream.getAudioTracks().forEach(track => {
          track.enabled = true;
          applyAudioTrackSettings(track);
        });
        localVideo.srcObject = localStream;
        localVideo.muted = true;
        localVideo.playsInline = true;
        localVideo.play().catch(() => {});
        localOverlay.style.display = 'none';
        updateMicIndicator(localStream.getAudioTracks().length > 0);
        return localStream;
      }
    }
  }

  localStream = createFallbackVideoStream();
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  localVideo.playsInline = true;
  localVideo.play().catch(() => {});
  localOverlay.style.display = 'none';
  updateMicIndicator(false);
  return localStream;
}

function updateMicIndicator(active) {
  if (micStatusIndicator) {
    if (active) {
      micStatusIndicator.innerHTML = '<span style="width: 8px; height: 8px; border-radius: 50%; background: #22c55e;"></span> Mic On';
      micStatusIndicator.style.color = '#22c55e';
    } else {
      micStatusIndicator.innerHTML = '<span style="width: 8px; height: 8px; border-radius: 50%; background: #ef4444;"></span> Mic Off';
      micStatusIndicator.style.color = '#ef4444';
    }
  }
}

// Ensure Camera and Microphone Tracks are Always Attached
async function ensureMicrophoneTrack() {
  if (!localStream || localStream.getAudioTracks().length === 0 || localStream.getVideoTracks().length === 0) {
    await initLocalCamera();
  }
  return localStream;
}

// 2. Connect WebSocket
const userId = 'user_' + Math.random().toString(36).substring(2, 9);
const socketId = 'soc_' + Math.random().toString(36).substring(2, 9);

function connectWebSocket() {
  const wsEndpoint = WS_URL + `?user_id=${userId}&socket_id=${socketId}`;
  
  try {
    socket = new WebSocket(wsEndpoint);

    socket.onopen = () => {
      console.log('✅ WebSocket connected. User:', userId);
    };

    socket.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data);
        await handleSignalEvent(payload);
      } catch (e) {
        console.error('Signal parse error:', e);
      }
    };

    socket.onclose = () => {
      setTimeout(connectWebSocket, 1500);
    };
  } catch (e) {
    console.warn('WebSocket error:', e);
  }
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 2200);
}

function getAuthToken() {
  return localStorage.getItem('omegle_auth_token') || '';
}

async function apiFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    body: options.body ? options.body : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  authTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.authTab === mode);
  });
  nameField.style.display = isSignup ? 'flex' : 'none';
  authSubmitBtn.textContent = isSignup ? 'Create Account' : 'Login';
  authStatus.textContent = '';
}

function renderProfile(user) {
  currentUser = user || null;
  if (!user) {
    profileAvatar.innerHTML = '<i class="fa-solid fa-user"></i>';
    profileAvatar.style.background = '#090d16';
    authProfileBox.style.display = 'none';
    return;
  }

  const letters = (user.name || user.email || 'U').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  profileAvatar.innerHTML = `<span>${letters}</span>`;
  profileAvatar.style.background = 'linear-gradient(135deg, #3b82f6, #1d4ed8)';
  profileAvatarLarge.textContent = letters;
  profileNameText.textContent = user.name || 'User';
  profileEmailText.textContent = user.email || '';
  authProfileBox.style.display = 'flex';
}

async function loadCurrentUser() {
  const token = getAuthToken();
  if (!token) {
    renderProfile(null);
    return;
  }

  try {
    const data = await apiFetch('/api/auth/me');
    renderProfile(data.user);
  } catch (error) {
    localStorage.removeItem('omegle_auth_token');
    renderProfile(null);
  }
}

function openAuthModal() {
  authModal.style.display = 'flex';
  if (currentUser) {
    authForm.style.display = 'none';
    authProfileBox.style.display = 'flex';
  } else {
    authForm.style.display = 'flex';
    authProfileBox.style.display = 'none';
    setAuthMode('login');
  }
}

function closeAuthModal() {
  authModal.style.display = 'none';
  authStatus.textContent = '';
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const name = fullName.value.trim();
  const email = authEmail.value.trim();
  const password = authPassword.value;

  if (!email || !password) {
    authStatus.textContent = 'Email and password are required.';
    return;
  }

  try {
    const endpoint = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const payload = authMode === 'signup'
      ? { name, email, password }
      : { email, password };

    const result = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    localStorage.setItem('omegle_auth_token', result.token);
    renderProfile(result.user);
    authForm.reset();
    closeAuthModal();
    showToast(authMode === 'signup' ? 'Account created successfully.' : 'Logged in successfully.');
  } catch (error) {
    authStatus.textContent = error.message;
  }
}

async function handleLogout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.warn('Logout request failed:', error);
  } finally {
    localStorage.removeItem('omegle_auth_token');
    renderProfile(null);
    authForm.style.display = 'flex';
    authProfileBox.style.display = 'none';
    authForm.reset();
    closeAuthModal();
    showToast('Logged out.');
  }
}

// 4. Safe ICE Candidate Queue & Drainage
async function addIceCandidateSafely(candidate) {
  if (!candidate) return;
  if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('❄️ Added ICE candidate directly');
    } catch (e) {
      console.warn('addIceCandidate error:', e);
    }
  } else {
    pendingCandidates.push(candidate);
    console.log('⏳ Queued ICE candidate. Pending count:', pendingCandidates.length);
  }
}

async function drainPendingIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  console.log(`🚀 Draining ${pendingCandidates.length} pending ICE candidates...`);
  while (pendingCandidates.length > 0) {
    const cand = pendingCandidates.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
    } catch (e) {
      console.warn('Error applying queued ICE candidate:', e);
    }
  }
}

// 3. Handle Signaling Events
async function handleSignalEvent(payload) {
  const { type, session_id, role, sdp, candidate, text, is_typing, peer_id } = payload;

  switch (type) {
    case 'searching':
      isMatching = true;
      isConnected = false;
      remoteStream = null;
      pendingCandidates = [];
      matchStatusText.textContent = 'Searching for a stranger...';
      startBtnText.textContent = 'Searching...';
      btnStartMatch.className = 'bottom-btn btn-start-match matching';
      strangerPlaceholder.style.display = 'flex';
      strangerBadge.style.display = 'none';
      remoteVideo.style.display = 'none';
      messageInput.disabled = true;
      btnSendMessage.disabled = true;
      break;

    case 'matched':
      sessionId = session_id;
      peerId = peer_id;
      isMatching = false;
      isConnected = true;
      remoteStream = null;
      pendingCandidates = [];
      matchStatusText.textContent = 'Connecting with stranger...';
      startBtnText.textContent = 'Next Match';
      btnStartMatch.className = 'bottom-btn btn-start-match connected';
      messageInput.disabled = false;
      btnSendMessage.disabled = false;
      messagesContainer.innerHTML = '<div class="message system-msg"><span>Connected to stranger. Say Hi!</span></div>';

      strangerPlaceholder.style.display = 'flex';
      strangerBadge.style.display = 'none';
      remoteVideo.style.display = 'none';

      await setupPeerConnection(role === 'initiator');
      break;

    case 'offer':
      console.log('Received WebRTC Offer, setting up answer...');
      sessionId = session_id || sessionId;
      if (peerConnectionInitPromise) {
        await peerConnectionInitPromise;
      } else if (!peerConnection) {
        await setupPeerConnection(false);
      }
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        await drainPendingIceCandidates();

        const answer = await peerConnection.createAnswer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await peerConnection.setLocalDescription(answer);
        sendSignal('answer', { session_id: sessionId, sdp: { type: answer.type, sdp: answer.sdp } });
        console.log('Sent WebRTC Answer with Audio & Video');
      } catch (e) {
        console.error('Error handling offer:', e);
      }
      break;

    case 'answer':
      console.log('Received WebRTC Answer');
      if (peerConnection && peerConnection.signalingState !== 'stable') {
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
          await drainPendingIceCandidates();
          console.log('WebRTC audio & video connected stably.');
        } catch (e) {
          console.error('Error handling answer:', e);
        }
      }
      break;

    case 'ice_candidate':
      if (candidate) {
        await addIceCandidateSafely(candidate);
      }
      break;

    case 'message':
      addMessage(text, payload.sender_id === userId ? 'you' : 'stranger');
      break;

    case 'typing':
      typingIndicator.style.display = is_typing ? 'block' : 'none';
      break;

    case 'peer_disconnected':
    case 'chat_ended':
      handleStrangerDisconnected();
      break;
  }
}

// 5. Setup WebRTC Peer Connection
async function setupPeerConnection(isInitiator) {
  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (e) {}
    peerConnection = null;
  }

  const initPromise = (async () => {
    peerConnection = new RTCPeerConnection({
      iceServers: STUN_SERVERS
    });

    // Attach local audio and video tracks directly
    const stream = await ensureMicrophoneTrack();
    if (stream) {
      stream.getTracks().forEach(track => {
        try {
          track.enabled = true;
          if (track.kind === 'audio') {
            applyAudioTrackSettings(track);
          }
          peerConnection.addTrack(track, stream);
          console.log(`🎤 Attached track to PeerConnection: ${track.kind} (id: ${track.id})`);
        } catch (e) {
          console.warn(`Failed to add ${track.kind} track:`, e);
        }
      });
    }

    // Ensure recv transceivers if any media kind is missing locally
    try {
      const senders = peerConnection.getSenders();
      const hasAudio = senders.some(s => s.track && s.track.kind === 'audio');
      const hasVideo = senders.some(s => s.track && s.track.kind === 'video');

      if (!hasAudio) peerConnection.addTransceiver('audio', { direction: 'recvonly' });
      if (!hasVideo) peerConnection.addTransceiver('video', { direction: 'recvonly' });
    } catch (e) {}

    // Native ontrack: Attach stream to remoteVideo & remoteAudio with unmuted audio playback
    peerConnection.ontrack = (event) => {
      console.log('🎥 WebRTC Track received:', event.track.kind, event.track.id);
      
      if (!remoteStream) {
        remoteStream = new MediaStream();
      }
      
      if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
        remoteStream.addTrack(event.track);
      }

      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach(t => {
          if (!remoteStream.getTracks().some(existing => existing.id === t.id)) {
            remoteStream.addTrack(t);
          }
        });
      }

      if (remoteVideo) {
        remoteVideo.srcObject = remoteStream;
        remoteVideo.playsInline = true;
        remoteVideo.autoplay = true;
        remoteVideo.style.display = 'block';
        remoteVideo.style.zIndex = '5';
        remoteVideo.play().catch(e => {
          console.warn('remoteVideo play:', e);
        });
      }

      if (remoteAudio) {
        remoteAudio.srcObject = remoteStream;
        remoteAudio.playsInline = true;
        remoteAudio.autoplay = true;
        remoteAudio.play().catch(e => {
          console.warn('remoteAudio play:', e);
        });
      }

      if (strangerPlaceholder) strangerPlaceholder.style.display = 'none';
      if (strangerBadge) strangerBadge.style.display = 'block';
      if (matchStatusText) matchStatusText.textContent = 'Live Connected!';
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('🔗 WebRTC Connection State:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        if (remoteStream && remoteStream.getVideoTracks().length > 0) {
          if (strangerPlaceholder) strangerPlaceholder.style.display = 'none';
          if (remoteVideo) remoteVideo.style.display = 'block';
          if (strangerBadge) strangerBadge.style.display = 'block';
        }
        matchStatusText.textContent = 'Live Connected!';
      } else if (peerConnection.connectionState === 'failed') {
        console.warn('WebRTC connection failed, attempting ICE restart...');
        try { peerConnection.restartIce(); } catch (e) {}
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log('❄️ ICE Connection State:', peerConnection.iceConnectionState);
      if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
        if (remoteStream && remoteStream.getVideoTracks().length > 0) {
          if (strangerPlaceholder) strangerPlaceholder.style.display = 'none';
          if (remoteVideo) remoteVideo.style.display = 'block';
          if (strangerBadge) strangerBadge.style.display = 'block';
        }
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && sessionId) {
        sendSignal('ice_candidate', { session_id: sessionId, candidate: event.candidate.toJSON() });
      }
    };

    return peerConnection;
  })();

  peerConnectionInitPromise = initPromise;
  await initPromise;

  if (isInitiator) {
    try {
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        voiceActivityDetection: true
      });
      await peerConnection.setLocalDescription(offer);
      sendSignal('offer', { session_id: sessionId, sdp: { type: offer.type, sdp: offer.sdp } });
      console.log('Sent WebRTC Offer with Audio & Video');
    } catch (e) {
      console.error('Error creating offer:', e);
    }
  }
}

function sendSignal(type, data = {}) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, data }));
  }
}

function unlockAudio() {
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      audioCtx = new AudioCtx();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  if (remoteVideo) {
    remoteVideo.muted = false;
    remoteVideo.volume = 1.0;
    remoteVideo.play().catch(() => {});
  }
  if (remoteAudio) {
    remoteAudio.muted = false;
    remoteAudio.volume = 1.0;
    remoteAudio.play().catch(() => {});
  }
}

// 6. Button Actions
btnStartMatch.addEventListener('click', async () => {
  unlockAudio();
  await ensureMicrophoneTrack();


  if (!isConnected && !isMatching) {
    sendSignal('join_queue', { chat_type: 'video' });
    isMatching = true;
    startBtnText.textContent = 'Searching...';
    btnStartMatch.className = 'bottom-btn btn-start-match matching';
    matchStatusText.textContent = 'Searching for a stranger...';
  } else {
    stopFrameStreaming();
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    remoteStream = null;
    sendSignal('next', { session_id: sessionId, chat_type: 'video' });
    isMatching = true;
    isConnected = false;
    startBtnText.textContent = 'Searching...';
    btnStartMatch.className = 'bottom-btn btn-start-match matching';
    strangerPlaceholder.style.display = 'flex';
    strangerBadge.style.display = 'none';
    if (remoteCanvas) remoteCanvas.style.display = 'none';
    remoteVideo.style.display = 'none';
    matchStatusText.textContent = 'Searching for a stranger...';
    messagesContainer.innerHTML = '';
  }
});

btnFreeMatch.addEventListener('click', () => {
  btnStartMatch.click();
});

btnStore.addEventListener('click', () => {
  showToast('Store is coming soon.');
});

profileAvatar.addEventListener('click', openAuthModal);
btnLogout.addEventListener('click', handleLogout);
authForm.addEventListener('submit', handleAuthSubmit);
authTabs.forEach(tab => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab));
});

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active'));
    link.classList.add('active');
    showToast(link.textContent.trim() + ' selected.');
  });
});

btnNewChat.addEventListener('click', () => {
  btnStartMatch.click();
});

if (btnToggleMic) {
  btnToggleMic.addEventListener('click', () => {
    isMuted = !isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
    updateMicIndicator(!isMuted);
    btnToggleMic.innerHTML = isMuted
      ? '<i class="fa-solid fa-microphone-slash"></i>'
      : '<i class="fa-solid fa-microphone"></i>';
    showToast(isMuted ? 'Microphone Muted' : 'Microphone Unmuted');
  });
}

if (btnToggleCam) {
  btnToggleCam.addEventListener('click', () => {
    isCamOff = !isCamOff;
    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !isCamOff;
      });
    }
    btnToggleCam.innerHTML = isCamOff
      ? '<i class="fa-solid fa-video-slash"></i>'
      : '<i class="fa-solid fa-video"></i>';
    showToast(isCamOff ? 'Camera Turned Off' : 'Camera Turned On');
  });
}

// Unlock audio on click or touch
['click', 'touchstart'].forEach(evt => {
  document.addEventListener(evt, () => {
    unlockAudio();
  });
});


function handleStrangerDisconnected() {
  stopFrameStreaming();
  isConnected = false;
  isMatching = false;
  remoteStream = null;
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  startBtnText.textContent = 'Start Match';
  btnStartMatch.className = 'bottom-btn btn-start-match';
  strangerPlaceholder.style.display = 'flex';
  strangerBadge.style.display = 'none';
  if (remoteCanvas) remoteCanvas.style.display = 'none';
  remoteVideo.style.display = 'none';
  matchStatusText.textContent = 'Stranger disconnected. Click "Start Match" to find another!';
  messageInput.disabled = true;
  btnSendMessage.disabled = true;
  addMessage('Stranger has disconnected.', 'system');
}



const btnGender = document.getElementById('btnGender');
let genderMode = 'any';

btnGender.addEventListener('click', () => {
  const modes = [
    { label: 'Male & Female', value: 'any' },
    { label: 'Women Only', value: 'female' },
    { label: 'Men Only', value: 'male' }
  ];
  const index = modes.findIndex(mode => mode.value === genderMode);
  genderMode = modes[(index + 1) % modes.length].value;
  btnGender.innerHTML = `<i class="fa-solid fa-venus-mars"></i> ${modes[(index + 1) % modes.length].label}`;
  showToast('Gender filter set to ' + modes[(index + 1) % modes.length].label + '.');
});

// 8. Text Chat
function addMessage(text, sender) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message msg-${sender}`;
  msgDiv.textContent = text;
  messagesContainer.appendChild(msgDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function handleSendMessage() {
  const text = messageInput.value.trim();
  if (!text || !sessionId) return;

  sendSignal('message', { session_id: sessionId, text: text, timestamp: new Date().toISOString() });
  messageInput.value = '';
  sendSignal('typing', { session_id: sessionId, is_typing: false });
}

btnSendMessage.addEventListener('click', handleSendMessage);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    handleSendMessage();
  }
});

messageInput.addEventListener('input', () => {
  if (sessionId) {
    sendSignal('typing', { session_id: sessionId, is_typing: messageInput.value.length > 0 });
  }
});

// 9. Modals
btnPreferences.addEventListener('click', () => {
  prefModal.style.display = 'flex';
});

btnCloseModal.addEventListener('click', () => {
  prefModal.style.display = 'none';
});

authModal.addEventListener('click', (event) => {
  if (event.target === authModal) {
    closeAuthModal();
  }
});

// Init on Load
window.addEventListener('DOMContentLoaded', () => {
  initLocalCamera();
  connectWebSocket();
  loadCurrentUser();
  setAuthMode('login');
});
