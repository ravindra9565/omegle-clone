# GlobChat - 1-on-1 Video & Audio Chat with Strangers 🌍 💬

A modern, high-performance, real-time random video & audio chat platform built with pure **HTML5**, **CSS3**, **Vanilla JavaScript (WebRTC)**, and a lightweight **FastAPI** Python signaling backend.

---

## ✨ Features

- **Simultaneous Video & Audio Calling**: Pure W3C WebRTC peer-to-peer audio & video streaming.
- **Voice Activity Visualizers**: Real-time Web Audio API frequency analyzers showing live audio levels & speaking waves for both local user and stranger.
- **Microphone & Camera Controls**: Seamless mic mute/unmute and camera toggle.
- **Stranger Audio Controls**: Instant stranger audio volume/speaker mute button.
- **Browser Autoplay Compliance**: Automatic audio context unlock on user interaction.
- **Real-Time Text Chat**: Instant messaging alongside video with typing indicators and timestamping.
- **Clean Architecture**: Single unified FastAPI backend with no obsolete dependencies.

---

## 📁 Project Structure

```text
omegle/
├── index.html          # Clean semantic UI with video, audio & chat components
├── style.css           # Modern dark-theme glassmorphism styling & audio waveforms
├── app.js              # WebRTC audio+video streaming, voice meters & signaling logic
├── server.py           # FastAPI WebSocket signaling & static server
├── requirements.txt    # Minimal dependencies (FastAPI + Uvicorn)
└── README.md
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```powershell
pip install -r requirements.txt
```

### 2. Start the Server
```powershell
python server.py
```

### 3. Open in Browser
Visit: **`http://localhost:3000`**

---

## 🧪 Testing with 2 Users

1. Open `http://localhost:3000` in your primary browser. Allow Camera & Microphone permissions.
2. Open `http://localhost:3000` in an **Incognito Window** (`Ctrl + Shift + N`) or a second browser.
3. Click **"Start Match"** in both windows.
4. You will instantly connect with live video, crystal-clear audio, voice activity waves, and real-time text chat!
