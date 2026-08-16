import os
import json
import uuid
import asyncio
import logging
import hashlib
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("omegle_server")

app = FastAPI(title="Omegle Server")

USER_STORE: Dict[str, dict] = {}
SESSION_TOKENS: Dict[str, str] = {}


def hash_password(password: str) -> str:
    return hashlib.sha256(password.strip().encode("utf-8")).hexdigest()


def get_token_from_request(request: Request) -> str | None:
    auth_header = request.headers.get("authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return request.headers.get("x-user-token")


@app.get("/api/online")
async def get_online_count():
    return {"online": len(manager.active_sockets)}


@app.post("/api/auth/signup")
async def signup(request: Request):
    payload = await request.json()
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
    payload = await request.json()
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


class SignalingManager:
    def __init__(self):
        self.active_sockets: Dict[str, WebSocket] = {}
        self.waiting_queue = []
        self.active_sessions: Dict[str, dict] = {}
        self.user_session_map: Dict[str, str] = {}

    async def connect(self, ws: WebSocket, user_id: str):
        await ws.accept()
        self.active_sockets[user_id] = ws
        logger.info(f"Connected: {user_id}")

    def disconnect(self, user_id: str):
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
            asyncio.create_task(self.send_to_user(peer, {"type": "peer_disconnected"}))

        logger.info(f"Disconnected: {user_id}")

    async def send_to_user(self, user_id: str, message: dict):
        if user_id in self.active_sockets:
            try:
                await self.active_sockets[user_id].send_text(json.dumps(message))
            except Exception as e:
                logger.error(f"Send error to {user_id}: {e}")

    async def join_queue(self, user_id: str):
        if user_id in self.user_session_map:
            return

        if user_id in self.waiting_queue:
            self.waiting_queue.remove(user_id)

        while len(self.waiting_queue) > 0:
            peer_id = self.waiting_queue.pop(0)
            if peer_id == user_id or peer_id not in self.active_sockets:
                continue

            session_id = str(uuid.uuid4())
            self.active_sessions[session_id] = {
                "user_a": user_id,
                "user_b": peer_id
            }
            self.user_session_map[user_id] = session_id
            self.user_session_map[peer_id] = session_id

            logger.info(f"MATCH: {user_id} <===> {peer_id} ({session_id})")

            await self.send_to_user(user_id, {
                "type": "matched",
                "session_id": session_id,
                "role": "initiator",
                "peer_id": peer_id
            })
            await self.send_to_user(peer_id, {
                "type": "matched",
                "session_id": session_id,
                "role": "receiver",
                "peer_id": user_id
            })
            return

        self.waiting_queue.append(user_id)
        logger.info(f"User {user_id} waiting in queue. (Total waiting: {len(self.waiting_queue)})")
        await self.send_to_user(user_id, {"type": "searching"})

    async def handle_next(self, user_id: str, session_id: str):
        sess_id = self.user_session_map.get(user_id) or session_id
        if sess_id and sess_id in self.active_sessions:
            sess = self.active_sessions[sess_id]
            peer = sess["user_b"] if sess["user_a"] == user_id else sess["user_a"]
            del self.active_sessions[sess_id]
            if user_id in self.user_session_map:
                del self.user_session_map[user_id]
            if peer in self.user_session_map:
                del self.user_session_map[peer]
            await self.send_to_user(peer, {"type": "peer_disconnected"})
        
        await self.join_queue(user_id)


manager = SignalingManager()


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
                await manager.join_queue(user_id)

            elif event_type == "next":
                sess_id = payload.get("session_id")
                await manager.handle_next(user_id, sess_id)

            elif event_type in ("offer", "answer", "ice_candidate", "message", "typing", "video_frame"):
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
                    if event_type in ("offer", "answer"):
                        logger.info(f"Signal {event_type} from {user_id} -> {peer}")
                    await manager.send_to_user(peer, msg_out)
                    if event_type == "message":
                        await manager.send_to_user(user_id, msg_out)
    except WebSocketDisconnect:
        manager.disconnect(user_id)


# Serve Static Files
@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "index.html"))

@app.get("/style.css")
async def serve_css():
    return FileResponse(os.path.join(os.path.dirname(__file__), "style.css"))

@app.get("/app.js")
async def serve_js():
    return FileResponse(os.path.join(os.path.dirname(__file__), "app.js"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)

