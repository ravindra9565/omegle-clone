const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

// Simple matchmaking queue stored in memory for POC
let waiting = [];

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('join', (meta) => {
    // meta may contain {anonymous: true, userId}
    console.log('join', socket.id, meta);
    if (waiting.length > 0) {
      const peerSocketId = waiting.shift();
      const roomId = uuidv4();
      socket.join(roomId);
      io.to(peerSocketId).socketsJoin(roomId);
      io.to(roomId).emit('matched', { roomId, peers: [peerSocketId, socket.id] });
      console.log('paired', peerSocketId, socket.id, 'room', roomId);
    } else {
      waiting.push(socket.id);
      socket.emit('waiting');
    }
  });

  socket.on('signal', (data) => {
    // data: { to, type, payload }
    if (data && data.to) {
      io.to(data.to).emit('signal', { from: socket.id, type: data.type, payload: data.payload });
    }
  });

  socket.on('leave', () => {
    waiting = waiting.filter(id => id !== socket.id);
    // leave all rooms
    const rooms = Array.from(socket.rooms).filter(r => r !== socket.id);
    rooms.forEach(r => socket.leave(r));
  });

  socket.on('disconnect', () => {
    waiting = waiting.filter(id => id !== socket.id);
    console.log('disconnect', socket.id);
  });
});

app.get('/.well-known/health', (req, res) => res.json({ ok: true }));

// Optional endpoint to retrieve TURN credentials (if using static creds)
app.get('/turn', (req, res) => {
  const turn = {
    urls: [process.env.TURN_URL || 'turn:YOUR_TURN_SERVER:3478'],
    username: process.env.TURN_USER || 'turnuser',
    credential: process.env.TURN_PASS || 'turnpass'
  };
  res.json(turn);
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Signaling server listening on', port));
