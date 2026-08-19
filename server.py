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

import sqlite3

# Dual Database Setup: Cloud PostgreSQL (Neon/Render) or Local SQLite
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

USE_POSTGRES = bool(DATABASE_URL)
psycopg2 = None
if USE_POSTGRES:
    try:
        import psycopg2
        logger.info("🐘 PostgreSQL Database Mode Enabled (Cloud DB: Neon/Render)")
    except ImportError:
        logger.warning("psycopg2 not installed locally, falling back to SQLite")
        USE_POSTGRES = False

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "globchat.db")


def get_db_connection():
    if USE_POSTGRES:
        return psycopg2.connect(DATABASE_URL)
    return sqlite3.connect(DB_PATH)


def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    if USE_POSTGRES:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                email VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                avatar TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token VARCHAR(255) PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Migration: ensure avatar column exists
        try:
            cursor.execute("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''")
        except Exception:
            pass
    else:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                email TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                avatar TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
            )
        """)
        # Migration: ensure avatar column exists
        try:
            cursor.execute("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''")
        except Exception:
            pass
    conn.commit()
    conn.close()
    logger.info("Database initialized successfully.")


init_db()


def hash_password(password: str) -> str:
    return hashlib.sha256(password.strip().encode("utf-8")).hexdigest()


def decode_jwt_payload(jwt_str: str) -> dict:
    """Safely decode JWT claims without external dependencies"""
    import base64
    try:
        parts = jwt_str.strip().split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1]
        rem = len(payload_b64) % 4
        if rem > 0:
            payload_b64 += "=" * (4 - rem)
        payload_bytes = base64.urlsafe_b64decode(payload_b64.encode("utf-8"))
        return json.loads(payload_bytes.decode("utf-8"))
    except Exception as e:
        logger.warning(f"Error decoding JWT payload: {e}")
        return {}


def db_get_user(email: str) -> Optional[dict]:
    conn = get_db_connection()
    cursor = conn.cursor()
    param = (email.lower().strip(),)
    if USE_POSTGRES:
        cursor.execute("SELECT email, name, password_hash, avatar FROM users WHERE email = %s", param)
    else:
        cursor.execute("SELECT email, name, password_hash, avatar FROM users WHERE email = ?", param)
    row = cursor.fetchone()
    conn.close()
    if row:
        return {
            "email": row[0],
            "name": row[1],
            "password_hash": row[2],
            "avatar": row[3] if len(row) > 3 and row[3] else ""
        }
    return None


def db_upsert_user(name: str, email: str, password_hash: str = "google_auth", avatar: str = "") -> bool:
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        email_clean = email.lower().strip()
        name_clean = name.strip()
        avatar_clean = (avatar or "").strip()

        if USE_POSTGRES:
            cursor.execute("""
                INSERT INTO users (email, name, password_hash, avatar) 
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (email) DO UPDATE 
                SET name = EXCLUDED.name, avatar = CASE WHEN EXCLUDED.avatar != '' THEN EXCLUDED.avatar ELSE users.avatar END
            """, (email_clean, name_clean, password_hash, avatar_clean))
        else:
            cursor.execute("""
                INSERT INTO users (email, name, password_hash, avatar) 
                VALUES (?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE 
                SET name = excluded.name, avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE users.avatar END
            """, (email_clean, name_clean, password_hash, avatar_clean))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        logger.error(f"Error upserting user: {e}")
        return False


def db_create_user(name: str, email: str, password_hash: str, avatar: str = "") -> bool:
    return db_upsert_user(name, email, password_hash, avatar)


def db_create_session(email: str) -> str:
    token = uuid.uuid4().hex
    conn = get_db_connection()
    cursor = conn.cursor()
    params = (token, email.lower().strip())
    if USE_POSTGRES:
        cursor.execute("INSERT INTO sessions (token, email) VALUES (%s, %s)", params)
    else:
        cursor.execute("INSERT INTO sessions (token, email) VALUES (?, ?)", params)
    conn.commit()
    conn.close()
    return token


def db_get_session_user(token: str) -> Optional[dict]:
    if not token:
        return None
    conn = get_db_connection()
    cursor = conn.cursor()
    params = (token.strip(),)
    query = """
        SELECT u.email, u.name, u.avatar 
        FROM sessions s 
        JOIN users u ON s.email = u.email 
        WHERE s.token = %s
    """ if USE_POSTGRES else """
        SELECT u.email, u.name, u.avatar 
        FROM sessions s 
        JOIN users u ON s.email = u.email 
        WHERE s.token = ?
    """
    cursor.execute(query, params)
    row = cursor.fetchone()
    conn.close()
    if row:
        return {"email": row[0], "name": row[1], "avatar": row[2] if len(row) > 2 and row[2] else ""}
    return None


def db_delete_session(token: str):
    if not token:
        return
    conn = get_db_connection()
    cursor = conn.cursor()
    params = (token.strip(),)
    if USE_POSTGRES:
        cursor.execute("DELETE FROM sessions WHERE token = %s", params)
    else:
        cursor.execute("DELETE FROM sessions WHERE token = ?", params)
    conn.commit()
    conn.close()


def get_token_from_request(request: Request) -> Optional[str]:
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return request.headers.get("x-user-token")


# =========================================================
# ANTI-SLEEP KEEP-ALIVE SYSTEM
# =========================================================
async def keep_alive_worker():
    """Background task that pings server to prevent free cloud hosting (Render/Glitch) from sleeping"""
    import urllib.request
    await asyncio.sleep(20)
    logger.info("🛡️ Server Keep-Alive anti-sleep worker started.")

    while True:
        try:
            external_url = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("KEEP_ALIVE_URL")
            if external_url:
                ping_url = external_url.rstrip("/") + "/healthz"
                try:
                    req = urllib.request.Request(
                        ping_url,
                        headers={"User-Agent": "GlobChat-AntiSleep-Daemon/1.0"}
                    )
                    with urllib.request.urlopen(req, timeout=12) as response:
                        logger.info(f"💓 Keep-Alive ping to {ping_url} - Status: {response.getcode()}")
                except Exception as ex:
                    logger.debug(f"Keep-Alive ping notice: {ex}")
        except Exception as e:
            logger.debug(f"Keep-alive worker exception: {e}")

        # Sleep for 9 minutes (Render free tier sleeps after 15 min idle)
        await asyncio.sleep(540)


@app.on_event("startup")
async def on_startup():
    init_db()
    asyncio.create_task(keep_alive_worker())


# =========================================================
# REST API ENDPOINTS & HEALTH CHECKS
# =========================================================
@app.get("/healthz")
@app.get("/health")
@app.head("/healthz")
@app.head("/")
async def health_check():
    return {"status": "ok", "service": "globchat", "active_users": len(manager.active_sockets)}


@app.get("/api/online")
async def get_online_count():
    count = max(1, len(manager.active_sockets))
    return {"online": count}


@app.post("/api/auth/google")
async def google_auth(request: Request):
    """Authenticate with Google Identity Services / One-Tap JWT credential"""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid request payload."}, status_code=400)

    credential = payload.get("credential")
    email = str(payload.get("email", "")).strip().lower()
    name = str(payload.get("name", "")).strip()
    avatar = str(payload.get("avatar") or payload.get("picture", "")).strip()

    if credential:
        claims = decode_jwt_payload(credential)
        if claims.get("email"):
            email = claims.get("email").strip().lower()
        if claims.get("name"):
            name = claims.get("name").strip()
        if claims.get("picture"):
            avatar = claims.get("picture").strip()

    if not email:
        return JSONResponse({"error": "Google email verification failed."}, status_code=400)
    if not name:
        name = email.split("@")[0].replace(".", " ").title()

    db_upsert_user(name, email, password_hash="google_oauth_jwt", avatar=avatar)
    token = db_create_session(email)
    user = db_get_user(email) or {"name": name, "email": email, "avatar": avatar}
    return {
        "token": token,
        "user": {
            "name": user.get("name", name),
            "email": email,
            "avatar": user.get("avatar", avatar)
        }
    }


@app.post("/api/auth/auto-login")
async def auto_login(request: Request):
    """Seamless background authentication for returning users - never blocks on restart"""
    token = get_token_from_request(request)
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    email = str(payload.get("email", "")).strip().lower()
    name = str(payload.get("name", "")).strip()
    avatar = str(payload.get("avatar", "")).strip()

    # 1. If valid session token exists in DB
    if token:
        user = db_get_session_user(token)
        if user:
            return {"token": token, "user": user}

    # 2. If token is missing/expired (e.g. server woke up or restarted), auto-restore via stored profile
    if email and "@" in email:
        if not name:
            name = email.split("@")[0].replace(".", " ").title()

        db_upsert_user(name, email, avatar=avatar)
        user = db_get_user(email) or {"name": name, "email": email, "avatar": avatar}
        new_token = db_create_session(email)
        return {
            "token": new_token,
            "user": {
                "name": user.get("name", name),
                "email": email,
                "avatar": user.get("avatar", avatar)
            }
        }

    return JSONResponse({"error": "No persistent session found."}, status_code=401)


@app.post("/api/auth/quick-login")
async def quick_login(request: Request):
    """1-Click Gmail login with persistent auto-account creation"""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid request JSON."}, status_code=400)

    email = str(payload.get("email", "")).strip().lower()
    name = str(payload.get("name", "")).strip()
    avatar = str(payload.get("avatar", "")).strip()

    if not email:
        return JSONResponse({"error": "Gmail / Email address is required."}, status_code=400)
    if "@" not in email or "." not in email:
        return JSONResponse({"error": "Please enter a valid Gmail / Email address."}, status_code=400)

    if not name:
        name = email.split("@")[0].replace(".", " ").title()

    db_upsert_user(name, email, password_hash="google_quick_auth", avatar=avatar)
    token = db_create_session(email)
    user = db_get_user(email) or {"name": name, "email": email, "avatar": avatar}
    return {
        "token": token,
        "user": {
            "name": user.get("name", name),
            "email": email,
            "avatar": user.get("avatar", avatar)
        }
    }


@app.post("/api/auth/guest-login")
async def guest_login(request: Request):
    """Instant guest access so visitors can start chatting with zero friction"""
    guest_num = random.randint(1000, 9999)
    name = f"Guest {guest_num}"
    email = f"guest_{guest_num}_{uuid.uuid4().hex[:6]}@globchat.local"
    db_upsert_user(name, email, password_hash="guest_session", avatar="")
    token = db_create_session(email)
    return {
        "token": token,
        "user": {
            "name": name,
            "email": email,
            "avatar": "",
            "is_guest": True
        }
    }


@app.post("/api/auth/signup")
async def signup(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid request JSON."}, status_code=400)

    name = str(payload.get("name", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    password = str(payload.get("password", "google_quick_auth"))

    if not email or "@" not in email:
        return JSONResponse({"error": "Valid email is required."}, status_code=400)

    if not name:
        name = email.split("@")[0].title()

    pwd_hash = hash_password(password)
    db_upsert_user(name, email, pwd_hash)
    token = db_create_session(email)
    user = db_get_user(email) or {"name": name, "email": email, "avatar": ""}
    return {"token": token, "user": {"name": user.get("name", name), "email": email, "avatar": user.get("avatar", "")}}


@app.post("/api/auth/login")
async def login(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid request JSON."}, status_code=400)

    email = str(payload.get("email", "")).strip().lower()
    name = str(payload.get("name", "")).strip()

    if not email:
        return JSONResponse({"error": "Email is required."}, status_code=400)

    if not name:
        name = email.split("@")[0].title()

    db_upsert_user(name, email, "google_quick_auth")
    token = db_create_session(email)
    user = db_get_user(email) or {"name": name, "email": email, "avatar": ""}
    return {"token": token, "user": {"name": user.get("name", name), "email": email, "avatar": user.get("avatar", "")}}


@app.get("/api/auth/me")
async def get_profile(request: Request):
    token = get_token_from_request(request)
    if not token:
        return JSONResponse({"error": "Not authenticated."}, status_code=401)

    user = db_get_session_user(token)
    if not user:
        return JSONResponse({"error": "Session expired or user not found."}, status_code=401)

    return {"user": user}


@app.post("/api/auth/logout")
async def logout(request: Request):
    token = get_token_from_request(request)
    if token:
        db_delete_session(token)
    return {"success": True}


# =========================================================
# WEBRTC SIGNALING MANAGER (PURE REAL-PEER RANDOM MATCHING)
# =========================================================
class SignalingManager:
    def __init__(self):
        self.active_sockets: Dict[str, WebSocket] = {}
        self.waiting_queue: List[str] = []
        self.active_sessions: Dict[str, dict] = {}
        self.user_session_map: Dict[str, str] = {}
        self.recent_peers: Dict[str, List[str]] = {}
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
        if len(self.recent_peers[u1]) > 5:
            self.recent_peers[u1].pop(0)

        if u2 not in self.recent_peers:
            self.recent_peers[u2] = []
        self.recent_peers[u2].append(u1)
        if len(self.recent_peers[u2]) > 5:
            self.recent_peers[u2].pop(0)

    async def join_queue(self, user_id: str, payload: Optional[dict] = None):
        async with self._lock:
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

            # Matchmaking: True Random Matching across different available real human strangers
            candidates = [p for p in self.waiting_queue if p != user_id and p in self.active_sockets]
            if candidates:
                recent_history = set(self.recent_peers.get(user_id, []))
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

                logger.info(f"🎲 RANDOM REAL PEER MATCH: {user_id} <===> {peer_id} (Session: {session_id})")

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

            # No peer ready right now -> Add to waiting queue
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

            if event_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong", "timestamp": payload.get("timestamp")}))
                continue

            elif event_type == "join_queue":
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

