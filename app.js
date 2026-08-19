// High-Speed Reliable WebRTC Configuration
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.services.mozilla.com' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelay',
      credential: 'openrelay'
    }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat';
const SESSION_STORAGE_KEY = 'globchat_persistent_session';

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
let isAutoMatching = false;
let isMuted = false;
let isCamOff = false;
let pendingCandidates = [];
let audioCtx = null;
let autoNextTimer = null;
let pingIntervalTimer = null;
let keepAliveHttpTimer = null;
let reconnectTimer = null;

// User & Stranger Profile State
let currentUser = null;
let currentStranger = null;
let userGeo = {
  city: '',
  state: 'Delhi',
  country: 'India',
  flag: '🇮🇳',
  location: 'Delhi, India 🇮🇳'
};

// DOM Elements
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remoteAudio = document.getElementById('remoteAudio');

const localOverlay = document.getElementById('localOverlay');
const strangerPlaceholder = document.getElementById('strangerPlaceholder');
const matchStatusText = document.getElementById('matchStatusText');
const strangerBadge = document.getElementById('strangerBadge');
const strangerVideoTagText = document.getElementById('strangerVideoTagText');
const strangerTagLoc = document.getElementById('strangerTagLoc');
const onlineCount = document.getElementById('onlineCount');
const micStatusIndicator = document.getElementById('micStatusIndicator');
const serverStatusBanner = document.getElementById('serverStatusBanner');
const serverStatusText = document.getElementById('serverStatusText');

const chatHeaderBar = document.getElementById('chatHeaderBar');
const strangerHeaderName = document.getElementById('strangerHeaderName');
const strangerLocationText = document.getElementById('strangerLocationText');
const strangerHeaderAvatar = document.getElementById('strangerHeaderAvatar');

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
const navAvatarImgContainer = document.getElementById('navAvatarImgContainer');
const navUserText = document.getElementById('navUserText');

const authModal = document.getElementById('authModal');
const btnCloseAuthModal = document.getElementById('btnCloseAuthModal');
const authProfileBox = document.getElementById('authProfileBox');
const profileNameText = document.getElementById('profileNameText');
const profileEmailText = document.getElementById('profileEmailText');
const profileAvatarLarge = document.getElementById('profileAvatarLarge');
const btnLogout = document.getElementById('btnLogout');
const authFormWrapper = document.getElementById('authFormWrapper');
const authForm = document.getElementById('authForm');
const fullName = document.getElementById('fullName');
const authEmail = document.getElementById('authEmail');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authStatus = document.getElementById('authStatus');

// =========================================================
// GEOLOCATION DETECTION (STATE & COUNTRY)
// =========================================================
async function fetchUserGeoLocation() {
  try {
    const res = await fetch('https://ipwho.is/', { cache: 'no-store' });
    const data = await res.json();
    if (data && data.success) {
      const city = data.city || '';
      const state = data.region || data.region_code || '';
      const country = data.country || 'India';
      const flag = data.flag?.emoji || '🇮🇳';
      const locDisplay = `${state ? state + ', ' : (city ? city + ', ' : '')}${country} ${flag}`;
      userGeo = {
        city,
        state: state || city || 'India',
        country,
        flag,
        location: locDisplay
      };
      return userGeo;
    }
  } catch (e) {
    console.debug('Geo lookup notice:', e);
  }

  // Backup fallback using Intl timezone
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz.includes('Calcutta') || tz.includes('Kolkata') || tz.includes('Asia')) {
      userGeo = { city: '', state: 'Uttar Pradesh', country: 'India', flag: '🇮🇳', location: 'Uttar Pradesh, India 🇮🇳' };
    }
  } catch (e) {}
  return userGeo;
}

fetchUserGeoLocation();

// =========================================================
// MATCHMAKING UI STATE
// =========================================================
function updateMatchUIState(state) {
  if (state === 'searching') {
    if (startBtnText) startBtnText.textContent = 'Searching...';
    if (btnStartMatch) btnStartMatch.className = 'bottom-btn btn-start-match matching';
    if (strangerPlaceholder) strangerPlaceholder.style.display = 'flex';
    if (strangerBadge) strangerBadge.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'none';
    if (messageInput) messageInput.disabled = true;
    if (btnSendMessage) btnSendMessage.disabled = true;
    if (matchStatusText) matchStatusText.textContent = 'Searching for a stranger...';
    if (chatHeaderBar) chatHeaderBar.style.display = 'none';
  } else if (state === 'connected') {
    if (startBtnText) startBtnText.textContent = 'Next Match';
    if (btnStartMatch) btnStartMatch.className = 'bottom-btn btn-start-match connected';
    if (strangerPlaceholder) strangerPlaceholder.style.display = 'none';
    if (strangerBadge) strangerBadge.style.display = 'flex';
    if (remoteVideo) remoteVideo.style.display = 'block';
    if (messageInput) messageInput.disabled = false;
    if (btnSendMessage) btnSendMessage.disabled = false;
    if (matchStatusText) matchStatusText.textContent = 'Live Connected!';
    if (chatHeaderBar) chatHeaderBar.style.display = 'flex';
  } else {
    // idle / initial
    if (startBtnText) startBtnText.textContent = 'Start Match';
    if (btnStartMatch) btnStartMatch.className = 'bottom-btn btn-start-match';
    if (strangerPlaceholder) strangerPlaceholder.style.display = 'flex';
    if (strangerBadge) strangerBadge.style.display = 'none';
    if (remoteVideo) remoteVideo.style.display = 'none';
    if (messageInput) messageInput.disabled = true;
    if (btnSendMessage) btnSendMessage.disabled = true;
    if (matchStatusText) matchStatusText.textContent = 'Click "Start Match" to meet someone!';
    if (chatHeaderBar) chatHeaderBar.style.display = 'none';
  }
}

async function fetchOnlineUsers() {
  try {
    const response = await fetch('/api/online', { cache: 'no-store' });
    const data = await response.json();
    const count = Number(data?.online || 1);
    if (onlineCount) onlineCount.textContent = count.toLocaleString();
  } catch (err) {
    if (onlineCount) onlineCount.textContent = '1';
  }
}

setInterval(fetchOnlineUsers, 8000);
fetchOnlineUsers();

// Insecure context warning for mobile browsers on HTTP
function checkSecureContext() {
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!window.isSecureContext && !isLocalhost) {
    console.warn('⚠️ Insecure Context: Mobile browsers block camera/mic over HTTP on LAN IPs.');
    showToast('⚠️ Mobile Notice: Camera/Mic requires HTTPS or a secure tunnel.');
  }
}

// Fallback animated stream if camera is busy or denied
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
    ctx.fillText(currentUser?.name || 'Live User', 320, 310);
    ctx.font = '14px Inter, sans-serif';
    ctx.fillText(userGeo.location || new Date().toLocaleTimeString(), 320, 340);

    requestAnimationFrame(draw);
  }
  draw();

  return canvas.captureStream(25);
}

function applyAudioTrackSettings(track) {
  if (!track || typeof track.applyConstraints !== 'function') return;
  track.applyConstraints({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }).catch(() => {});
}

// 1. Initialize Local Camera and Microphone
async function initLocalCamera() {
  if (localStream && localStream.getTracks().length > 0) {
    const hasLiveVideo = localStream.getVideoTracks().some(t => t.readyState === 'live');
    if (hasLiveVideo) return localStream;
  }
  
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const attemptConfigs = [
      { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: { echoCancellation: true, noiseSuppression: true } },
      { video: { facingMode: 'user' }, audio: true },
      { video: true, audio: true },
      { video: true, audio: false }
    ];

    for (const config of attemptConfigs) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia(config);
        if (localStream) {
          console.log('✅ Camera acquired successfully with config:', config);
          break;
        }
      } catch (err) {
        console.warn('getUserMedia attempt failed for config:', config, err.name);
      }
    }

    if (localStream && localStream.getAudioTracks().length === 0) {
      try {
        const audioOnlyStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioOnlyStream.getAudioTracks().forEach(t => localStream.addTrack(t));
      } catch (ea) {
        console.warn('Audio-only fallback notice:', ea);
      }
    }

    if (localStream && localStream.getVideoTracks().length > 0) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !isCamOff;
      });
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
        applyAudioTrackSettings(track);
      });

      localVideo.srcObject = localStream;
      localVideo.muted = true;
      localVideo.playsInline = true;
      localVideo.setAttribute('playsinline', '');
      localVideo.setAttribute('webkit-playsinline', '');
      localVideo.play().catch(e => console.warn('localVideo play:', e));
      if (localOverlay) localOverlay.style.display = 'none';
      updateMicIndicator(localStream.getAudioTracks().length > 0 && !isMuted);
      return localStream;
    }
  }

  // Fallback stream if camera is busy or denied
  console.warn('Falling back to animated canvas video stream.');
  localStream = createFallbackVideoStream();
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  localVideo.playsInline = true;
  localVideo.setAttribute('playsinline', '');
  localVideo.setAttribute('webkit-playsinline', '');
  localVideo.play().catch(() => {});
  if (localOverlay) localOverlay.style.display = 'none';
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

async function ensureMicrophoneTrack() {
  if (!localStream) {
    await initLocalCamera();
  }
  return localStream;
}

// =========================================================
// 2. WEBSOCKET & ANTI-SLEEP KEEP-ALIVE SYSTEM
// =========================================================
const userId = 'user_' + Math.random().toString(36).substring(2, 9);
const socketId = 'soc_' + Math.random().toString(36).substring(2, 9);

function showServerStatus(text, isError = false) {
  if (!serverStatusBanner) return;
  serverStatusBanner.style.display = 'flex';
  if (serverStatusText) serverStatusText.textContent = text;
  if (isError) {
    serverStatusBanner.classList.add('error');
  } else {
    serverStatusBanner.classList.remove('error');
  }
}

function hideServerStatus() {
  if (serverStatusBanner) serverStatusBanner.style.display = 'none';
}

function connectWebSocket() {
  const wsEndpoint = WS_URL + `?user_id=${userId}&socket_id=${socketId}`;
  
  try {
    socket = new WebSocket(wsEndpoint);

    socket.onopen = () => {
      console.log('✅ WebSocket connected. User:', userId);
      hideServerStatus();
      clearInterval(pingIntervalTimer);

      // WebSocket Heartbeat Ping every 20s to prevent proxy timeouts
      pingIntervalTimer = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', data: { timestamp: Date.now() } }));
        }
      }, 20000);
    };

    socket.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'pong') {
          return;
        }
        await handleSignalEvent(payload);
      } catch (e) {
        console.error('Signal parse error:', e);
      }
    };

    socket.onclose = () => {
      clearInterval(pingIntervalTimer);
      showServerStatus('⚡ Server sleeping or reconnecting... Re-establishing connection...');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWebSocket, 2000);
    };

    socket.onerror = () => {
      showServerStatus('⚡ Connecting to GlobChat server...');
    };
  } catch (e) {
    console.warn('WebSocket init notice:', e);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 2500);
  }
}

// Client HTTP Keep-Alive Ping every 3 minutes while browser tab is open
function startHttpKeepAlive() {
  clearInterval(keepAliveHttpTimer);
  keepAliveHttpTimer = setInterval(async () => {
    try {
      await fetch('/healthz', { cache: 'no-store' });
    } catch (e) {
      console.debug('Keep-alive ping attempt:', e);
    }
  }, 180000);
}
startHttpKeepAlive();

function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 2500);
}

// =========================================================
// 3. PERSISTENT AUTHENTICATION (GMAIL ONLY)
// =========================================================
function getStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session && (session.token || session.user)) {
      return session;
    }
  } catch (e) {}
  return null;
}

function saveStoredSession(user, token) {
  try {
    const sessionData = {
      user: user,
      token: token || '',
      savedAt: Date.now()
    };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionData));
    localStorage.setItem('omegle_auth_token', token || '');
  } catch (e) {
    console.warn('Failed to persist session to localStorage:', e);
  }
}

function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem('omegle_auth_token');
  } catch (e) {}
}

async function apiFetch(url, options = {}) {
  const session = getStoredSession();
  const token = session?.token || localStorage.getItem('omegle_auth_token') || '';
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

function renderProfile(user) {
  currentUser = user || null;
  
  if (!user) {
    if (navAvatarImgContainer) {
      navAvatarImgContainer.innerHTML = '<i class="fa-solid fa-circle-user"></i>';
    }
    if (navUserText) navUserText.textContent = 'Login';
    if (profileAvatar) {
      profileAvatar.style.background = '#2563eb';
    }
    if (authProfileBox) authProfileBox.style.display = 'none';
    if (authFormWrapper) authFormWrapper.style.display = 'block';
    return;
  }

  const name = user.name || user.email?.split('@')[0] || 'User';
  const email = user.email || '';
  const avatarUrl = user.avatar || '';

  // Update Navbar Profile
  if (navUserText) navUserText.textContent = name;
  if (profileAvatar) {
    profileAvatar.style.background = 'linear-gradient(135deg, #10b981, #059669)';
  }
  if (navAvatarImgContainer) {
    if (avatarUrl && avatarUrl.startsWith('http')) {
      navAvatarImgContainer.innerHTML = `<img src="${avatarUrl}" alt="${name}" class="nav-avatar-photo" onerror="this.outerHTML='<i class=\\\'fa-solid fa-user-check\\\'></i>'" />`;
    } else {
      navAvatarImgContainer.innerHTML = '<i class="fa-solid fa-user-check"></i>';
    }
  }

  // Update Auth Modal Profile Box
  if (profileNameText) profileNameText.textContent = name;
  if (profileEmailText) profileEmailText.textContent = email;
  if (profileAvatarLarge) {
    if (avatarUrl && avatarUrl.startsWith('http')) {
      profileAvatarLarge.innerHTML = `<img src="${avatarUrl}" alt="${name}" class="large-avatar-photo" onerror="this.outerHTML='${name.charAt(0).toUpperCase()}'" />`;
    } else {
      const initials = (name || 'U').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
      profileAvatarLarge.textContent = initials;
    }
  }

  if (authProfileBox) authProfileBox.style.display = 'flex';
  if (authFormWrapper) authFormWrapper.style.display = 'none';
}

// Silent, non-blocking auto-login on load
async function loadCurrentUser() {
  const session = getStoredSession();

  if (session && session.user) {
    // Instantly apply user credentials from permanent localStorage
    renderProfile(session.user);
    if (authModal) authModal.style.display = 'none';
    initLocalCamera();

    // Verify & refresh session in background without disrupting UI
    try {
      const result = await apiFetch('/api/auth/auto-login', {
        method: 'POST',
        body: JSON.stringify({
          email: session.user.email,
          name: session.user.name,
          avatar: session.user.avatar || ''
        })
      });

      if (result && result.user) {
        saveStoredSession(result.user, result.token);
        renderProfile(result.user);
      }
    } catch (e) {
      console.debug('Background session sync notice:', e);
    }
    return;
  }

  // No saved session -> Open modal & initialize Google Sign-In
  renderProfile(null);
  openAuthModal();
}

function openAuthModal() {
  if (!authModal) return;
  authModal.style.display = 'flex';
  if (currentUser) {
    if (authFormWrapper) authFormWrapper.style.display = 'none';
    if (authProfileBox) authProfileBox.style.display = 'flex';
    if (btnCloseAuthModal) btnCloseAuthModal.style.display = 'flex';
  } else {
    if (authFormWrapper) authFormWrapper.style.display = 'block';
    if (authProfileBox) authProfileBox.style.display = 'none';
    if (btnCloseAuthModal) btnCloseAuthModal.style.display = 'none';

    // Auto pre-fill last saved name & email
    const lastEmail = localStorage.getItem('globchat_last_email') || 'ravindraprajapati6296@gmail.com';
    const lastName = localStorage.getItem('globchat_last_name') || 'Ravindra';
    if (authEmail && !authEmail.value && lastEmail) {
      authEmail.value = lastEmail;
    }
    if (fullName && !fullName.value && lastName) {
      fullName.value = lastName;
    }
  }
}

function closeAuthModal() {
  if (!currentUser) {
    showToast('⚠️ Please enter your Gmail to start chatting.');
    return;
  }
  if (authModal) authModal.style.display = 'none';
  if (authStatus) authStatus.textContent = '';
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const name = fullName ? fullName.value.trim() : '';
  const email = authEmail ? authEmail.value.trim() : '';

  if (!email) {
    if (authStatus) authStatus.textContent = 'Please enter your Gmail / Email address.';
    return;
  }
  if (!email.includes('@') || !email.includes('.')) {
    if (authStatus) authStatus.textContent = 'Please enter a valid Gmail address (e.g. name@gmail.com).';
    return;
  }

  if (authSubmitBtn) {
    authSubmitBtn.disabled = true;
    authSubmitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Connecting...</span>';
  }

  try {
    const result = await apiFetch('/api/auth/quick-login', {
      method: 'POST',
      body: JSON.stringify({ name: name || email.split('@')[0], email: email })
    });

    saveStoredSession(result.user, result.token);
    localStorage.setItem('globchat_last_email', email);
    if (name) localStorage.setItem('globchat_last_name', name);

    renderProfile(result.user);
    if (authForm) authForm.reset();
    if (authModal) authModal.style.display = 'none';
    if (authStatus) authStatus.textContent = '';
    
    initLocalCamera();
    showToast(`🎉 Welcome, ${result.user.name}! You are permanently signed in.`);
  } catch (error) {
    if (authStatus) authStatus.textContent = error.message || 'Login failed. Please try again.';
  } finally {
    if (authSubmitBtn) {
      authSubmitBtn.disabled = false;
      authSubmitBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path fill="#ffffff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#ffffff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#ffffff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#ffffff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>
        <span>Continue with Gmail</span>
      `;
    }
  }
}

async function handleLogout() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.warn('Logout request notice:', error);
  } finally {
    clearStoredSession();
    currentUser = null;
    renderProfile(null);
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    updateMatchUIState('idle');
    openAuthModal();
    showToast('Logged out successfully.');
  }
}

// =========================================================
// 4. WEBRTC SIGNALING & PEER CONNECTION
// =========================================================
async function addIceCandidateSafely(candidate) {
  if (!candidate || (!candidate.candidate && typeof candidate !== 'string')) return;
  
  if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('addIceCandidate error:', e);
    }
  } else {
    pendingCandidates.push(candidate);
  }
}

async function drainPendingIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  while (pendingCandidates.length > 0) {
    const cand = pendingCandidates.shift();
    try {
      if (cand && (cand.candidate || typeof cand === 'string')) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      }
    } catch (e) {
      console.warn('Error applying queued ICE candidate:', e);
    }
  }
}

async function handleSignalEvent(payload) {
  const { type, session_id, role, sdp, candidate, text, is_typing, peer_id, stranger_info } = payload;

  switch (type) {
    case 'searching':
      if (peerConnection) {
        try { peerConnection.close(); } catch (e) {}
        peerConnection = null;
      }
      if (remoteVideo) remoteVideo.srcObject = null;
      if (remoteAudio) remoteAudio.srcObject = null;
      isMatching = true;
      isConnected = false;
      remoteStream = null;
      currentStranger = null;
      pendingCandidates = [];
      updateMatchUIState('searching');
      break;

    case 'matched':
      sessionId = session_id;
      peerId = peer_id;
      isMatching = false;
      isConnected = true;
      remoteStream = null;
      pendingCandidates = [];
      if (remoteVideo) remoteVideo.srcObject = null;
      if (remoteAudio) remoteAudio.srcObject = null;
      updateMatchUIState('connected');

      // Update Stranger Info & Location Display
      currentStranger = stranger_info || {};
      const sName = currentStranger.name || 'Stranger';
      const sLoc = currentStranger.location || `${currentStranger.state ? currentStranger.state + ', ' : ''}${currentStranger.country || 'India'} ${currentStranger.flag || '🇮🇳'}`;

      if (strangerHeaderName) strangerHeaderName.textContent = sName;
      if (strangerLocationText) strangerLocationText.textContent = sLoc;
      if (strangerHeaderAvatar) {
        strangerHeaderAvatar.textContent = sName.charAt(0).toUpperCase();
      }
      if (strangerVideoTagText) strangerVideoTagText.textContent = sName.toUpperCase();
      if (strangerTagLoc) strangerTagLoc.textContent = sLoc;
      if (strangerBadge) strangerBadge.style.display = 'flex';
      if (chatHeaderBar) chatHeaderBar.style.display = 'flex';

      messagesContainer.innerHTML = `<div class="message system-msg"><span>🎉 Connected with <strong>${sName}</strong> from <strong>${sLoc}</strong>! Say Hi!</span></div>`;
      if (matchStatusText) matchStatusText.textContent = `Connected to ${sName} (${sLoc})`;
      
      await setupPeerConnection(role === 'initiator');
      break;

    case 'offer':
      console.log('Received WebRTC Offer, preparing answer...');
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
        console.log('✅ Sent WebRTC Answer with Audio & Video');
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
          console.log('✅ WebRTC peer connection established stably.');
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
      const isMe = payload.sender_id === userId;
      addMessage(text, isMe ? 'you' : 'stranger', isMe ? 'You' : (currentStranger?.name || 'Stranger'));
      break;

    case 'typing':
      if (typingIndicator) {
        const typingName = currentStranger?.name || 'Stranger';
        typingIndicator.innerHTML = `<span>${typingName} is typing...</span>`;
        typingIndicator.style.display = is_typing ? 'block' : 'none';
      }
      break;

    case 'stopped':
      updateMatchUIState('idle');
      break;

    case 'peer_disconnected':
    case 'chat_ended':
      handleStrangerDisconnected();
      break;
  }
}

async function setupPeerConnection(isInitiator) {
  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (e) {}
    peerConnection = null;
  }

  const initPromise = (async () => {
    peerConnection = new RTCPeerConnection(RTC_CONFIG);

    const stream = await ensureMicrophoneTrack();
    if (stream) {
      stream.getTracks().forEach(track => {
        try {
          track.enabled = (track.kind === 'video') ? !isCamOff : !isMuted;
          if (track.kind === 'audio') {
            applyAudioTrackSettings(track);
          }
          peerConnection.addTrack(track, stream);
        } catch (e) {
          console.warn(`Failed to add ${track.kind} track:`, e);
        }
      });
    }

    try {
      const senders = peerConnection.getSenders();
      const hasAudio = senders.some(s => s.track && s.track.kind === 'audio');
      const hasVideo = senders.some(s => s.track && s.track.kind === 'video');

      if (!hasAudio) peerConnection.addTransceiver('audio', { direction: 'recvonly' });
      if (!hasVideo) peerConnection.addTransceiver('video', { direction: 'recvonly' });
    } catch (e) {}

    peerConnection.ontrack = (event) => {
      console.log('🎥 WebRTC Track received:', event.track.kind);

      let incomingStream = (event.streams && event.streams[0]) ? event.streams[0] : null;
      if (!incomingStream) {
        if (!remoteStream) {
          remoteStream = new MediaStream();
        }
        if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
          remoteStream.addTrack(event.track);
        }
        incomingStream = remoteStream;
      } else {
        remoteStream = incomingStream;
      }

      if (remoteVideo) {
        if (remoteVideo.srcObject !== incomingStream) {
          remoteVideo.srcObject = incomingStream;
        }
        remoteVideo.muted = true;
        remoteVideo.playsInline = true;
        remoteVideo.setAttribute('playsinline', '');
        remoteVideo.setAttribute('webkit-playsinline', '');
        remoteVideo.style.display = 'block';
        remoteVideo.style.zIndex = '6';

        const triggerPlayback = () => {
          const p = remoteVideo.play();
          if (p !== undefined) {
            p.then(() => {
              if (strangerPlaceholder) strangerPlaceholder.style.display = 'none';
              if (strangerBadge) strangerBadge.style.display = 'flex';
              if (matchStatusText) matchStatusText.textContent = 'Live Connected!';
            }).catch(err => {
              remoteVideo.muted = true;
              remoteVideo.play().catch(() => {});
            });
          }
        };

        triggerPlayback();
        remoteVideo.onloadedmetadata = triggerPlayback;
        remoteVideo.onloadeddata = triggerPlayback;
        remoteVideo.oncanplay = triggerPlayback;
      }

      if (remoteAudio) {
        if (remoteAudio.srcObject !== incomingStream) {
          remoteAudio.srcObject = incomingStream;
        }
        remoteAudio.playsInline = true;
        remoteAudio.play().catch(e => console.warn('remoteAudio play:', e));
      }
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('🔗 WebRTC Connection State:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        if (strangerPlaceholder) strangerPlaceholder.style.display = 'none';
        if (remoteVideo) remoteVideo.style.display = 'block';
        if (strangerBadge) strangerBadge.style.display = 'flex';
        if (matchStatusText) matchStatusText.textContent = 'Live Connected!';
      } else if (peerConnection.connectionState === 'failed') {
        try { peerConnection.restartIce(); } catch (e) {}
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && sessionId) {
        const candData = event.candidate.toJSON ? event.candidate.toJSON() : {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex
        };
        if (candData && candData.candidate) {
          sendSignal('ice_candidate', { session_id: sessionId, candidate: candData });
        }
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
        voiceActivityDetection: false
      });
      await peerConnection.setLocalDescription(offer);
      sendSignal('offer', { session_id: sessionId, sdp: { type: offer.type, sdp: offer.sdp } });
      console.log('⚡ Sent WebRTC Offer');
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

// 5. Matchmaking Action
async function handleMatchButtonClick() {
  if (!currentUser) {
    showToast('⚠️ Please enter your Gmail to start video chat!');
    openAuthModal();
    return;
  }

  unlockAudio();
  await ensureMicrophoneTrack();
  clearTimeout(autoNextTimer);

  const payloadInfo = {
    chat_type: 'video',
    gender: genderMode,
    user_info: {
      name: currentUser.name || 'User',
      email: currentUser.email || '',
      avatar: currentUser.avatar || '',
      city: userGeo.city,
      state: userGeo.state,
      country: userGeo.country,
      flag: userGeo.flag,
      location: userGeo.location
    }
  };

  if (!isAutoMatching) {
    isAutoMatching = true;
    isMatching = true;
    isConnected = false;
    updateMatchUIState('searching');
    sendSignal('join_queue', payloadInfo);
  } else {
    if (peerConnection) {
      try { peerConnection.close(); } catch (e) {}
      peerConnection = null;
    }
    remoteStream = null;
    currentStranger = null;
    pendingCandidates = [];
    isMatching = true;
    isConnected = false;
    messagesContainer.innerHTML = '';
    updateMatchUIState('searching');
    matchStatusText.textContent = 'Skipping to next stranger...';
    sendSignal('next', { session_id: sessionId, ...payloadInfo });
  }
}

function handleStrangerDisconnected() {
  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
    peerConnection = null;
  }
  remoteStream = null;
  pendingCandidates = [];
  isConnected = false;
  currentStranger = null;

  if (isAutoMatching) {
    isMatching = true;
    updateMatchUIState('searching');
    matchStatusText.textContent = 'Stranger disconnected. Finding next stranger...';
    showToast('Stranger left. Finding next...');
    addMessage('Stranger has disconnected. Finding next stranger...', 'system');
    
    sendSignal('join_queue', {
      chat_type: 'video',
      gender: genderMode,
      user_info: {
        name: currentUser?.name || 'User',
        email: currentUser?.email || '',
        avatar: currentUser?.avatar || '',
        city: userGeo.city,
        state: userGeo.state,
        country: userGeo.country,
        flag: userGeo.flag,
        location: userGeo.location
      }
    });
  } else {
    updateMatchUIState('idle');
    matchStatusText.textContent = 'Stranger disconnected. Click "Start Match" to find another!';
    addMessage('Stranger has disconnected.', 'system');
  }
}

// =========================================================
// 6. EVENT LISTENERS & INITIALIZATION
// =========================================================
if (btnStartMatch) btnStartMatch.addEventListener('click', handleMatchButtonClick);
if (btnFreeMatch) btnFreeMatch.addEventListener('click', handleMatchButtonClick);
if (btnNewChat) btnNewChat.addEventListener('click', handleMatchButtonClick);

if (btnStore) {
  btnStore.addEventListener('click', () => {
    showToast('Store is coming soon.');
  });
}

if (profileAvatar) profileAvatar.addEventListener('click', openAuthModal);
if (btnCloseAuthModal) btnCloseAuthModal.addEventListener('click', closeAuthModal);
if (btnLogout) btnLogout.addEventListener('click', handleLogout);
if (authForm) authForm.addEventListener('submit', handleAuthSubmit);

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active'));
    link.classList.add('active');
    showToast(link.textContent.trim() + ' selected.');
  });
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

['click', 'touchstart', 'touchend', 'pointerdown'].forEach(evt => {
  document.addEventListener(evt, () => {
    unlockAudio();
  }, { passive: true });
});

// Keyboard shortcuts (Space / Right Arrow)
window.addEventListener('keydown', (e) => {
  const isInputFocused = document.activeElement && (
    document.activeElement.tagName === 'INPUT' || 
    document.activeElement.tagName === 'TEXTAREA'
  );

  if ((e.key === ' ' || e.key === 'ArrowRight') && !isInputFocused) {
    e.preventDefault();
    handleMatchButtonClick();
  }
});

const btnGender = document.getElementById('btnGender');
let genderMode = 'any';

if (btnGender) {
  btnGender.addEventListener('click', () => {
    const modes = [
      { label: 'Male & Female', value: 'any' },
      { label: 'Women Only', value: 'female' },
      { label: 'Men Only', value: 'male' }
    ];
    const index = modes.findIndex(mode => mode.value === genderMode);
    genderMode = modes[(index + 1) % modes.length].value;
    btnGender.innerHTML = `<i class="fa-solid fa-venus-mars"></i> <span>${modes[(index + 1) % modes.length].label}</span>`;
    showToast('Gender filter set to ' + modes[(index + 1) % modes.length].label + '.');
  });
}

// 7. Text Chat with Stranger Name
function addMessage(text, sender, senderName) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message msg-${sender}`;
  
  if (sender !== 'system' && (senderName || currentStranger?.name)) {
    const nameLabel = document.createElement('div');
    nameLabel.className = 'msg-sender-name';
    nameLabel.textContent = sender === 'you' ? 'You' : (senderName || currentStranger?.name || 'Stranger');
    msgDiv.appendChild(nameLabel);
  }
  
  const textSpan = document.createElement('div');
  textSpan.className = 'msg-text-content';
  textSpan.innerHTML = text;
  msgDiv.appendChild(textSpan);

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

if (btnSendMessage) btnSendMessage.addEventListener('click', handleSendMessage);
if (messageInput) {
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
}

if (btnPreferences) {
  btnPreferences.addEventListener('click', () => {
    prefModal.style.display = 'flex';
  });
}

if (btnCloseModal) {
  btnCloseModal.addEventListener('click', () => {
    prefModal.style.display = 'none';
  });
}

if (authModal) {
  authModal.addEventListener('click', (event) => {
    if (event.target === authModal && currentUser) {
      closeAuthModal();
    }
  });
}

// Run on Page Load
window.addEventListener('DOMContentLoaded', () => {
  checkSecureContext();
  connectWebSocket();
  loadCurrentUser();
  updateMatchUIState('idle');
});
