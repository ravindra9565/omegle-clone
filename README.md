# Omegle Clone (Pure HTML, CSS, JavaScript)

A functional, pixel-perfect 1-to-1 random video and text chat platform built with pure **HTML5**, **CSS3**, **Vanilla JavaScript**, **WebRTC**, and a lightweight Python WebSocket server.

---

## 📁 Clean Project Structure

```text
omegle/
├── index.html          # Main HTML structure matching the UI screenshot
├── style.css           # Styling for navbar, video cards, buttons & chat
├── app.js              # WebRTC P2P media, WebSocket signaling & text chat logic
├── server.py           # Standalone WebSocket & HTTP server
├── requirements.txt    # Minimal dependencies (FastAPI + Uvicorn)
└── README.md
```

---

## 🚀 How to Run

1. **Activate Virtual Environment or Install Requirements**:
   ```powershell
   pip install -r requirements.txt
   ```

2. **Start the Server**:
   ```powershell
   python server.py
   ```

3. **Open in Browser**:
   👉 **`http://localhost:3000`**

---

## 🧪 Testing with 2 Users (2 Windows)

1. Open `http://localhost:3000` in your main browser window. Allow camera & mic permissions.
2. Open `http://localhost:3000` in an **Incognito Window** (Ctrl + Shift + N) or second browser.
3. Click **"Start Match"** in both windows.
4. Both windows will match instantly with live video streaming and real-time text chat!
