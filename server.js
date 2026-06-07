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

// Database simple (en mémoire)
const users = new Map();
const onlineSessions = new Map();

function generateUserId() {
  return 'usr_' + Math.random().toString(36).substr(2, 9);
}

// Routes API
app.post('/api/user/init', (req, res) => {
  let { userId } = req.body;
  
  if (!userId || !users.has(userId)) {
    userId = generateUserId();
    users.set(userId, {
      id: userId,
      username: 'Joueur' + Math.floor(Math.random() * 10000),
      avatarColor: '#3b82f6',
      maxStreakHira: 0,
      maxStreakKata: 0,
      totalExp: 0,
      totalGames: 0
    });
  }
  
  res.json({ userId, user: users.get(userId) });
});

app.get('/api/user/:userId', (req, res) => {
  const user = users.get(req.params.userId);
  if (user) {
    res.json(user);
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.post('/api/user/:userId/update', (req, res) => {
  const user = users.get(req.params.userId);
  if (user) {
    const { username, avatarColor, maxStreakHira, maxStreakKata, totalExp, totalGames } = req.body;
    if (username) user.username = username;
    if (avatarColor) user.avatarColor = avatarColor;
    if (maxStreakHira !== undefined) user.maxStreakHira = Math.max(user.maxStreakHira, maxStreakHira);
    if (maxStreakKata !== undefined) user.maxStreakKata = Math.max(user.maxStreakKata, maxStreakKata);
    if (totalExp !== undefined) user.totalExp = totalExp;
    if (totalGames !== undefined) user.totalGames = totalGames;
    
    res.json(user);
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.get('/api/leaderboard', (req, res) => {
  const leaderboard = Array.from(users.values())
    .map(user => ({
      id: user.id,
      username: user.username,
      avatarColor: user.avatarColor,
      maxStreakHira: user.maxStreakHira,
      maxStreakKata: user.maxStreakKata,
      maxStreakCombined: Math.max(user.maxStreakHira, user.maxStreakKata),
      totalExp: user.totalExp,
      totalGames: user.totalGames
    }))
    .sort((a, b) => b.totalExp - a.totalExp)
    .slice(0, 100);
  
  res.json(leaderboard);
});

// Socket.io pour les connexions
io.on('connection', (socket) => {
  let userId = null;

  socket.on('user_connect', (id) => {
    userId = id;
    onlineSessions.set(socket.id, userId);
    io.emit('leaderboard_update', 'refresh');
  });

  socket.on('disconnect', () => {
    if (userId) {
      onlineSessions.delete(socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🎮 Serveur lancé sur port ${PORT}`);
});
