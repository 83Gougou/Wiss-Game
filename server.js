const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Stockage des sessions utilisateurs
const sessions = new Map();

io.on('connection', (socket) => {
  console.log('Nouvel utilisateur connecté:', socket.id);

  socket.on('user_join', (username) => {
    sessions.set(socket.id, { username, joinedAt: Date.now() });
    io.emit('user_list', Array.from(sessions.values()));
    io.emit('chat_message', {
      system: true,
      message: `${username} a rejoint le serveur`,
      timestamp: Date.now()
    });
  });

  socket.on('send_message', (message) => {
    const session = sessions.get(socket.id);
    if (session) {
      io.emit('chat_message', {
        username: session.username,
        message,
        timestamp: Date.now()
      });
    }
  });

  socket.on('add_friend', (friendUsername) => {
    const session = sessions.get(socket.id);
    if (session) {
      socket.emit('friend_added', friendUsername);
    }
  });

  socket.on('disconnect', () => {
    const session = sessions.get(socket.id);
    if (session) {
      io.emit('chat_message', {
        system: true,
        message: `${session.username} a quitté le serveur`,
        timestamp: Date.now()
      });
    }
    sessions.delete(socket.id);
    io.emit('user_list', Array.from(sessions.values()));
  });
});

server.listen(PORT, () => {
  console.log(`🎮 Serveur lancé sur port ${PORT}`);
});
