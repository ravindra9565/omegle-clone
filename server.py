"""
GlobChat Backend Server
FastAPI WebRTC WebSocket Signaling and Static Server
"""

import os
import json
import uuid
import random
import asyncio
import logging
import hashlib
from typing import Dict, Optional, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

# Logging Setup
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("globchat_server")

app = FastAPI(title="GlobChat Server", version="2.0.0")

# In-memory authentication and session store
USER_STORE: Dict[str, dict] = {}
SESSION_TOKENS: Dict[str, str] = {}


def hash_password(password: str) -> str:
    return hashlib.sha256(password.strip().encode("utf-8")).hexdigest()


def get_token_from_request(request: Request) -> Optional[str]:
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return request.headers.get("x-user-token")


# =========================================================
# REST API ENDPOINTS
# =========================================================
@app.get("/api/online")
async def get_online_count():
    count = max(1, len(manager.active_sockets))
    return {"online": count}


@app.post("/api/auth/signup")
async def signup(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid request JSON."}, status_code=400)

    name = str(payload.get("name", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    password = str(payload.get("password", ""))

    if not name or not email or not password:
        return JSONResponse({"error": "Name, email and password are required."}, status_code=400)
    if "@" not in email or "." not in email:
        return JSONResponse({"error": "Please enter a valid email address."}, status_code=400)
    if email in USER_STORE:
        return JSONResponse({"error": "This email is already registered."}, status_code=409)

    USER_STORE[email] = {
        "name": name,
        "email": email,
        "password_hash": hash_password(password)
    }

    token = uuid.uuid4().hex
    SESSION_TOKENS[token] = email
    return {"token": token, "user": {"name": name, "email": email}}


@app.post("/api/auth/login")
async def login(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid request JSON."}, status_code=400)

    email = str(payload.get("email", "")).strip().lower()
    password = str(payload.get("password", ""))

    user = USER_STORE.get(email)
    if not user or user["password_hash"] != hash_password(password):
        return JSONResponse({"error": "Invalid email or password."}, status_code=401)

    token = uuid.uuid4().hex
    SESSION_TOKENS[token] = email
    return {"token": token, "user": {"name": user["name"], "email": user["email"]}}


@app.get("/api/auth/me")
async def get_profile(request: Request):
    token = get_token_from_request(request)
    email = SESSION_TOKENS.get(token)
    if not email:
        return JSONResponse({"error": "Not authenticated."}, status_code=401)

    user = USER_STORE.get(email)
    if not user:
        return JSONResponse({"error": "User not found."}, status_code=404)

    return {"user": {"name": user["name"], "email": user["email"]}}


@app.post("/api/auth/logout")
async def logout(request: Request):
    token = get_token_from_request(request)
    if token and token in SESSION_TOKENS:
        del SESSION_TOKENS[token]
    return {"success": True}


# =========================================================
# WEBRTC SIGNALING MANAGER
# =========================================================
class SignalingManager:
    def __init__(self):
        self.active_sockets: Dict[str, WebSocket] = {}
        self.waiting_queue: List[str] = []
        self.active_sessions: Dict[str, dict] = {}
        self.user_session_map: Dict[str, str] = {}
        self.recent_peers: Dict[str, List[str]] = {}
        self.user_meta: Dict[str, dict] = {}
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket, user_id: str):
        await ws.accept()
        self.active_sockets[user_id] = ws
        logger.info(f"User connected: {user_id} (Total online: {len(self.active_sockets)})")

    async def disconnect(self, user_id: str):
        async with self._lock:
            if user_id in self.active_sockets:
                del self.active_sockets[user_id]
            if user_id in self.waiting_queue:
                self.waiting_queue.remove(user_id)
            if user_id in self.user_meta:
                del self.user_meta[user_id]

            sess_id = self.user_session_map.get(user_id)
            if sess_id and sess_id in self.active_sessions:
                sess = self.active_sessions[sess_id]
                peer = sess["user_b"] if sess["user_a"] == user_id else sess["user_a"]
                del self.active_sessions[sess_id]
                if user_id in self.user_session_map:
                    del self.user_session_map[user_id]
                if peer in self.user_session_map:
                    del self.user_session_map[peer]
                self._record_recent_peer(user_id, peer)
                asyncio.create_task(self.send_to_user(peer, {"type": "peer_disconnected"}))

        logger.info(f"User disconnected: {user_id}")

    async def send_to_user(self, user_id: str, message: dict):
        if user_id in self.active_sockets:
            try:
                await self.active_sockets[user_id].send_text(json.dumps(message))
            except Exception as e:
                logger.error(f"Failed to send to {user_id}: {e}")

    def _record_recent_peer(self, u1: str, u2: str):
        if u1 not in self.recent_peers:
            self.recent_peers[u1] = []
        self.recent_peers[u1].append(u2)
        if len(self.recent_peers[u1]) > 10:
            self.recent_peers[u1].pop(0)

        if u2 not in self.recent_peers:
            self.recent_peers[u2] = []
        self.recent_peers[u2].append(u1)
        if len(self.recent_peers[u2]) > 10:
            self.recent_peers[u2].pop(0)

    async def join_queue(self, user_id: str, payload: Optional[dict] = None):
        async with self._lock:
            if payload:
                self.user_meta[user_id] = payload

            # Clean dead sockets and remove self from queue
            self.waiting_queue = [p for p in self.waiting_queue if p in self.active_sockets and p != user_id]

            # If already in a session, disconnect old session first and record match history
            sess_id = self.user_session_map.get(user_id)
            if sess_id and sess_id in self.active_sessions:
                sess = self.active_sessions[sess_id]
                peer = sess["user_b"] if sess["user_a"] == user_id else sess["user_a"]
                del self.active_sessions[sess_id]
                if user_id in self.user_session_map:
                    del self.user_session_map[user_id]
                if peer in self.user_session_map:
                    del self.user_session_map[peer]
                self._record_recent_peer(user_id, peer)
                asyncio.create_task(self.send_to_user(peer, {"type": "peer_disconnected"}))

            # Matchmaking: True Random Matching across different available strangers
            candidates = [p for p in self.waiting_queue if p != user_id and p in self.active_sockets]
            if candidates:
                recent_history = set(self.recent_peers.get(user_id, []))
                # Prioritize fresh strangers who the user hasn't met recently
                fresh_candidates = [p for p in candidates if p not in recent_history]

                if fresh_candidates:
                    peer_id = random.choice(fresh_candidates)
                else:
                    peer_id = random.choice(candidates)

                self.waiting_queue.remove(peer_id)
                self._record_recent_peer(user_id, peer_id)

                session_id = str(uuid.uuid4())
                self.active_sessions[session_id] = {
                    "user_a": user_id,
                    "user_b": peer_id
                }
                self.user_session_map[user_id] = session_id
                self.user_session_map[peer_id] = session_id

                logger.info(f"🎲 TRUE RANDOM MATCH: {user_id} <===> {peer_id} (Session: {session_id})")

                # Dispatch matched events concurrently for minimal latency
                await asyncio.gather(
                    self.send_to_user(user_id, {
                        "type": "matched",
                        "session_id": session_id,
                        "role": "initiator",
                        "peer_id": peer_id
                    }),
                    self.send_to_user(peer_id, {
                        "type": "matched",
                        "session_id": session_id,
                        "role": "receiver",
                        "peer_id": user_id
                    })
                )
                return

            # No peer available -> Add to waiting queue
            self.waiting_queue.append(user_id)
            logger.info(f"User {user_id} waiting in queue. (Queue count: {len(self.waiting_queue)})")
            await self.send_to_user(user_id, {"type": "searching"})

    async def handle_next(self, user_id: str, payload: Optional[dict] = None):
        await self.join_queue(user_id, payload)

    async def leave_queue(self, user_id: str):
        async with self._lock:
            if user_id in self.waiting_queue:
                self.waiting_queue.remove(user_id)
            sess_id = self.user_session_map.get(user_id)
            if sess_id and sess_id in self.active_sessions:
                sess = self.active_sessions[sess_id]
                peer = sess["user_b"] if sess["user_a"] == user_id else sess["user_a"]
                del self.active_sessions[sess_id]
                if user_id in self.user_session_map:
                    del self.user_session_map[user_id]
                if peer in self.user_session_map:
                    del self.user_session_map[peer]
                self._record_recent_peer(user_id, peer)
                asyncio.create_task(self.send_to_user(peer, {"type": "peer_disconnected"}))
        await self.send_to_user(user_id, {"type": "stopped"})


manager = SignalingManager()


# =========================================================
# WEBSOCKET ENDPOINT
# =========================================================
@app.websocket("/ws/chat")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str = Query(...),
    socket_id: str = Query(...)
):
    await manager.connect(websocket, user_id)
    try:
        while True:
            text_data = await websocket.receive_text()
            data = json.loads(text_data)
            event_type = data.get("type")
            payload = data.get("data", {})

            if event_type == "join_queue":
                await manager.join_queue(user_id, payload)

            elif event_type in ("next", "skip"):
                await manager.handle_next(user_id, payload)

            elif event_type == "stop":
                await manager.leave_queue(user_id)

            elif event_type in ("offer", "answer", "ice_candidate", "message", "typing"):
                sess_id = payload.get("session_id") or manager.user_session_map.get(user_id)
                if sess_id and sess_id in manager.active_sessions:
                    sess = manager.active_sessions[sess_id]
                    peer = sess["user_b"] if sess["user_a"] == user_id else sess["user_a"]

                    msg_out = {
                        "type": event_type,
                        "session_id": sess_id,
                        "sender_id": user_id,
                        **payload
                    }
                    await manager.send_to_user(peer, msg_out)
                    if event_type == "message":
                        await manager.send_to_user(user_id, msg_out)

    except WebSocketDisconnect:
        await manager.disconnect(user_id)
    except Exception as e:
        logger.error(f"WebSocket error for {user_id}: {e}")
        await manager.disconnect(user_id)



# =========================================================
# STATIC FILE SERVING
# =========================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


@app.get("/")
async def serve_index():
    return FileResponse(
        os.path.join(BASE_DIR, "index.html"),
        media_type="text/html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )


@app.get("/style.css")
async def serve_css():
    return FileResponse(
        os.path.join(BASE_DIR, "style.css"),
        media_type="text/css",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )


@app.get("/app.js")
async def serve_js():
    return FileResponse(
        os.path.join(BASE_DIR, "app.js"),
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
    )


# =========================================================
# SERVER ENTRYPOINT
# =========================================================
def get_local_ip() -> str:
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    import sys
    port = int(os.environ.get("PORT", 3000))
    local_ip = get_local_ip()
    
    use_ssl = (
        "--ssl" in sys.argv 
        or os.environ.get("SSL", "").lower() in ("1", "true", "yes")
    )
    
    cert_file = os.path.join(BASE_DIR, "cert.pem")
    key_file = os.path.join(BASE_DIR, "key.pem")
    
    has_cert = os.path.exists(cert_file) and os.path.exists(key_file)
    
    if use_ssl and has_cert:
        proto = "https"
        print(f"\n========================================================")
        print(f"🔒 GlobChat Server running with HTTPS / WSS:")
        print(f"👉 Local:   https://localhost:{port}")
        print(f"👉 Phone:   https://{local_ip}:{port}")
        print(f"========================================================\n")
        uvicorn.run(
            "server:app",
            host="0.0.0.0",
            port=port,
            ssl_certfile=cert_file,
            ssl_keyfile=key_file,
            reload=False
        )
    else:
        proto = "http"
        print(f"\n========================================================")
        print(f"🚀 GlobChat Server running:")
        print(f"👉 Local:   http://localhost:{port}")
        print(f"👉 Phone:   http://{local_ip}:{port}")
        if has_cert:
            print(f"💡 To run with HTTPS for mobile camera: python server.py --ssl")
        print(f"💡 For public internet access, use: npx untun tunnel http://localhost:{port}")
        print(f"========================================================\n")
        uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)

