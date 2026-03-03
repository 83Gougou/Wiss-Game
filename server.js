const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function generateSeed() {
  return Math.floor(Math.random() * 999999);
}

io.on('connection', (socket) => {

  // Créer une salle
  socket.on('create_room', ({ name, color, isPrivate }) => {
    const code = generateCode();
    rooms[code] = {
      code, isPrivate: !!isPrivate,
      host: socket.id,
      players: {},
      started: false,
      seed: null,
      startTime: null,
      spawnInterval: null,
    };
    rooms[code].players[socket.id] = { id: socket.id, name: name || 'Joueur', color: color || '#ff6b6b', x: 0, y: 0, alive: true, score: 0 };
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  // Rejoindre une salle
  socket.on('join_room', ({ code, name, color }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Salle introuvable' });
    if (room.started) return socket.emit('error', { msg: 'Partie déjà en cours' });
    if (Object.keys(room.players).length >= 8) return socket.emit('error', { msg: 'Salle pleine (max 8)' });
    room.players[socket.id] = { id: socket.id, name: name || 'Joueur', color: color || '#4ecdc4', x: 0, y: 0, alive: true, score: 0 };
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  // Lancer la partie
  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (Object.keys(room.players).length < 1) return;

    room.started = true;
    room.seed = generateSeed();
    room.startTime = Date.now();

    // Reset players
    Object.values(room.players).forEach(p => {
      p.alive = true;
      p.x = 400; p.y = 300;
    });

    io.to(code).emit('game_start', {
      seed: room.seed,
      startTime: room.startTime,
      players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color })),
    });

    broadcastPublicRooms();

    // Spawn signals — serveur dit juste "spawne maintenant", client fait la physique
    let spawnCount = 3;
    // Initial spawn
    setTimeout(() => {
      io.to(code).emit('spawn_ball', { count: spawnCount, elapsed: 0 });
    }, 1500);

    // Every 10s add more
    room.spawnInterval = setInterval(() => {
      if (!room.started) return;
      spawnCount = Math.min(spawnCount + 1, 25);
      io.to(code).emit('spawn_ball', { count: 1, elapsed: (Date.now() - room.startTime) / 1000 });
    }, 10000);
  });

  // Position souris
  socket.on('mouse_pos', ({ code, x, y }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].x = x;
    room.players[socket.id].y = y;
    // Broadcast to others only
    socket.to(code).emit('player_moved', { id: socket.id, x, y });
  });

  // Joueur mort (validé côté client)
  socket.on('i_died', ({ code, survivalTime }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    p.alive = false;
    p.survivalTime = survivalTime;
    p.xpEarned = Math.floor(survivalTime * 2);
    io.to(code).emit('player_died', { id: socket.id, name: p.name, time: survivalTime });

    // Check si tout le monde est mort
    const alive = Object.values(room.players).filter(p => p.alive);
    if (alive.length === 0) endRoom(room);
  });

  // Rejouer
  socket.on('restart_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    clearInterval(room.spawnInterval);
    room.started = false;
    broadcastLobby(code);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (!room.players[socket.id]) continue;
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) {
        clearInterval(room.spawnInterval);
        delete rooms[code];
      } else {
        if (room.host === socket.id) room.host = Object.keys(room.players)[0];
        broadcastLobby(code);
      }
      broadcastPublicRooms();
    }
  });

  // Liste des salles publiques
  socket.on('get_rooms', () => {
    socket.emit('public_rooms', getPublicRooms());
  });
});

function endRoom(room) {
  clearInterval(room.spawnInterval);
  room.started = false;
  const scores = Object.values(room.players)
    .map(p => ({ id: p.id, name: p.name, color: p.color, time: p.survivalTime || 0, xp: p.xpEarned || 0 }))
    .sort((a, b) => b.time - a.time);
  io.to(room.code).emit('game_over', { scores });
  broadcastPublicRooms();
}

function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('lobby_update', {
    code,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color })),
    hostId: room.host,
    isPrivate: room.isPrivate,
    started: room.started,
  });
}

function getPublicRooms() {
  return Object.values(rooms)
    .filter(r => !r.isPrivate && !r.started)
    .map(r => ({
      code: r.code,
      playerCount: Object.keys(r.players).length,
      hostName: Object.values(r.players)[0]?.name || '?',
    }));
}

function broadcastPublicRooms() {
  io.emit('public_rooms', getPublicRooms());
}

server.listen(process.env.PORT || 3000, () => console.log('Server on port', process.env.PORT || 3000));
