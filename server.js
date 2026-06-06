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

// Stockage des utilisateurs et amis (en mémoire pour demo, sinon database)
const users = new Map(); // userId -> {username, socketId, stats, friends[]}
const onlineUsers = new Map(); // socketId -> userId
const userStats = new Map(); // userId -> {maxStreakHira, maxStreakKata, exp, totalQuestions}

// Fonction pour générer un ID utilisateur unique
function generateUserId() {
  return 'user_' + Math.random().toString(36).substr(2, 9);
}

io.on('connection', (socket) => {
  console.log('Utilisateur connecté:', socket.id);

  socket.on('user_join', (username) => {
    let userId = socket.handshake.query.userId;
    
    // Si pas d'userId existant, en créer un nouveau
    if (!userId || !users.has(userId)) {
      userId = generateUserId();
    }

    onlineUsers.set(socket.id, userId);

    // Créer ou mettre à jour l'utilisateur
    if (!users.has(userId)) {
      users.set(userId, {
        id: userId,
        username: username,
        socketId: socket.id,
        friends: [],
        createdAt: Date.now()
      });
      userStats.set(userId, {
        maxStreakHira: 0,
        maxStreakKata: 0,
        exp: 0,
        totalQuestions: 0
      });
    } else {
      users.get(userId).socketId = socket.id;
    }

    // Envoyer l'ID utilisateur au client
    socket.emit('user_id', userId);

    // Diffuser la liste des utilisateurs en ligne
    broadcastOnlineUsers();
  });

  socket.on('update_stats', (userId, stats) => {
    if (userStats.has(userId)) {
      userStats.set(userId, stats);
    }
  });

  socket.on('add_friend', (userId, friendId) => {
    if (users.has(userId) && users.has(friendId)) {
      const user = users.get(userId);
      const friend = users.get(friendId);

      // Ajouter à la liste d'amis si pas déjà présent
      if (!user.friends.includes(friendId)) {
        user.friends.push(friendId);
        io.to(socket.id).emit('friend_added', friendId);
      }
    }
  });

  socket.on('get_user_profile', (userId, callback) => {
    if (users.has(userId)) {
      const user = users.get(userId);
      const stats = userStats.get(userId) || {};
      callback({
        id: user.id,
        username: user.username,
        friends: user.friends.length,
        ...stats
      });
    }
  });

  socket.on('get_online_users', (callback) => {
    const onlineList = Array.from(onlineUsers.values())
      .map(userId => {
        const user = users.get(userId);
        const stats = userStats.get(userId) || {};
        return {
          id: userId,
          username: user.username,
          maxStreak: Math.max(stats.maxStreakHira || 0, stats.maxStreakKata || 0),
          exp: stats.exp || 0,
          isFriend: false // À vérifier côté client
        };
      });
    callback(onlineList);
  });

  socket.on('get_friends', (userId, callback) => {
    if (users.has(userId)) {
      const user = users.get(userId);
      const friendsList = user.friends.map(friendId => {
        const friend = users.get(friendId);
        const stats = userStats.get(friendId) || {};
        return {
          id: friendId,
          username: friend.username,
          maxStreak: Math.max(stats.maxStreakHira || 0, stats.maxStreakKata || 0),
          exp: stats.exp || 0
        };
      });
      callback(friendsList);
    }
  });

  socket.on('disconnect', () => {
    const userId = onlineUsers.get(socket.id);
    if (userId) {
      const user = users.get(userId);
      if (user) {
        user.socketId = null;
      }
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers();
    }
  });
});

function broadcastOnlineUsers() {
  const onlineList = Array.from(onlineUsers.values())
    .map(userId => {
      const user = users.get(userId);
      const stats = userStats.get(userId) || {};
      return {
        id: userId,
        username: user.username,
        maxStreak: Math.max(stats.maxStreakHira || 0, stats.maxStreakKata || 0),
        exp: stats.exp || 0
      };
    });
  io.emit('online_users', onlineList);
}

server.listen(PORT, () => {
  console.log(`🎮 Serveur lancé sur port ${PORT}`);
});
