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
app.use(express.json());

const PORT = process.env.PORT || 3000;

// In-memory storage (persisted per server session, survives reconnects)
const users = new Map();       // userId -> { id, username, color, socketId, createdAt, stats }
const onlineUsers = new Map(); // socketId -> userId
const chatMessages = [];       // last 100 chat messages
const MAX_CHAT = 100;

function generateUserId() {
  return 'u_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
}

function getUserPublic(userId) {
  const u = users.get(userId);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    color: u.color,
    online: !!u.socketId,
    stats: u.stats
  };
}

function getLeaderboard() {
  const all = Array.from(users.values()).map(u => ({
    id: u.id,
    username: u.username,
    color: u.color,
    online: !!u.socketId,
    exp: u.stats.exp,
    maxStreakHira: u.stats.maxStreakHira,
    maxStreakKata: u.stats.maxStreakKata,
    totalScore: u.stats.exp + (u.stats.maxStreakHira * 5) + (u.stats.maxStreakKata * 5)
  }));
  return all;
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // JOIN / RECONNECT
  socket.on('user_join', (data, callback) => {
    const { userId, username, color } = data;
    let uid = userId;
    let isNew = false;

    if (!uid || !users.has(uid)) {
      uid = generateUserId();
      isNew = true;
    }

    const user = users.get(uid);
    if (isNew || !user) {
      users.set(uid, {
        id: uid,
        username: username || ('Player' + Math.floor(Math.random() * 9999)),
        color: color || '#2563eb',
        socketId: socket.id,
        createdAt: Date.now(),
        stats: { maxStreakHira: 0, maxStreakKata: 0, exp: 0, totalQuestions: 0, correctAnswers: 0 }
      });
    } else {
      user.socketId = socket.id;
      if (username) user.username = username;
      if (color) user.color = color;
    }

    onlineUsers.set(socket.id, uid);

    // Send back user data
    const me = users.get(uid);
    if (typeof callback === 'function') {
      callback({
        userId: uid,
        username: me.username,
        color: me.color,
        stats: me.stats
      });
    }

    // Broadcast updated online list
    broadcastOnlineList();
    // Send leaderboard
    io.emit('leaderboard', getLeaderboard());
  });

  // UPDATE STATS
  socket.on('update_stats', (data) => {
    const { userId, stats } = data;
    if (!userId || !users.has(userId)) return;
    const u = users.get(userId);
    // Only update if better (prevent cheating / rollback)
    u.stats.exp = Math.max(u.stats.exp, stats.exp || 0);
    u.stats.maxStreakHira = Math.max(u.stats.maxStreakHira, stats.maxStreakHira || 0);
    u.stats.maxStreakKata = Math.max(u.stats.maxStreakKata, stats.maxStreakKata || 0);
    u.stats.totalQuestions = Math.max(u.stats.totalQuestions, stats.totalQuestions || 0);
    u.stats.correctAnswers = Math.max(u.stats.correctAnswers, stats.correctAnswers || 0);
    io.emit('leaderboard', getLeaderboard());
  });

  // UPDATE PROFILE (username/color)
  socket.on('update_profile', (data, callback) => {
    const { userId, username, color } = data;
    if (!userId || !users.has(userId)) return;
    const u = users.get(userId);
    if (username && username.trim().length > 0) {
      u.username = username.trim().substring(0, 20);
    }
    if (color) u.color = color;
    broadcastOnlineList();
    io.emit('leaderboard', getLeaderboard());
    if (typeof callback === 'function') callback({ ok: true, username: u.username, color: u.color });
  });

  // GET USER PROFILE
  socket.on('get_profile', (userId, callback) => {
    const pub = getUserPublic(userId);
    if (typeof callback === 'function') callback(pub);
  });

  // CHAT
  socket.on('chat_message', (data) => {
    const { userId, text } = data;
    if (!userId || !users.has(userId)) return;
    if (!text || text.trim().length === 0 || text.length > 300) return;
    const u = users.get(userId);
    const msg = {
      id: Date.now() + Math.random(),
      userId: u.id,
      username: u.username,
      color: u.color,
      text: text.trim(),
      ts: Date.now()
    };
    chatMessages.push(msg);
    if (chatMessages.length > MAX_CHAT) chatMessages.shift();
    io.emit('chat_message', msg);
  });

  // GET CHAT HISTORY
  socket.on('get_chat_history', (callback) => {
    if (typeof callback === 'function') callback(chatMessages.slice(-50));
  });

  // GET LEADERBOARD
  socket.on('get_leaderboard', (callback) => {
    if (typeof callback === 'function') callback(getLeaderboard());
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const uid = onlineUsers.get(socket.id);
    if (uid && users.has(uid)) {
      users.get(uid).socketId = null;
    }
    onlineUsers.delete(socket.id);
    broadcastOnlineList();
    io.emit('leaderboard', getLeaderboard());
  });
});

function broadcastOnlineList() {
  const list = Array.from(onlineUsers.values()).map(uid => getUserPublic(uid)).filter(Boolean);
  io.emit('online_users', list);
}

server.listen(PORT, () => {
  console.log(`🎮 Japanese Master server running on port ${PORT}`);
});
