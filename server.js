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

function getPublicRooms() {
  return Object.values(rooms)
    .filter(r => !r.isPrivate && !r.started)
    .map(r => ({
      code: r.code,
      playerCount: Object.keys(r.players).length,
      hostName: Object.values(r.players)[0]?.name || '?',
      maxPlayers: 8,
    }));
}

function broadcastPublicRooms() {
  io.emit('public_rooms', getPublicRooms());
}

function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('lobby_update', {
    code,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color })),
    hostId: room.host,
    isPrivate: room.isPrivate,
  });
}

function cleanupRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearInterval(room.spawnInterval);
  clearInterval(room.coinInterval);
  delete rooms[code];
  broadcastPublicRooms();
}

function leaveRoom(socket, code) {
  const room = rooms[code];
  if (!room || !room.players[socket.id]) return;
  const wasHost = room.host === socket.id;
  delete room.players[socket.id];
  socket.leave(code);

  if (Object.keys(room.players).length === 0) {
    cleanupRoom(code);
    return;
  }
  if (wasHost) {
    room.host = Object.keys(room.players)[0];
    io.to(code).emit('new_host', { hostId: room.host });
  }
  if (room.started) {
    const alive = Object.values(room.players).filter(p => p.alive);
    if (alive.length === 0) endRoom(room);
  } else {
    broadcastLobby(code);
  }
  broadcastPublicRooms();
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ name, color, isPrivate, maxBalls, spawnRate }) => {
    for (const code in rooms) {
      if (rooms[code].players[socket.id]) leaveRoom(socket, code);
    }
    const code = generateCode();
    rooms[code] = {
      code, isPrivate: !!isPrivate, host: socket.id,
      players: {}, started: false,
      spawnInterval: null, coinInterval: null,
      maxBalls: maxBalls || 25,
      spawnRate: spawnRate || 10000,
    };
    rooms[code].players[socket.id] = {
      id: socket.id, name: name || 'Joueur', color: color || '#ff6b6b',
      alive: true, survivalTime: 0, xpEarned: 0, coins: 0,
    };
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  socket.on('join_room', ({ code, name, color }) => {
    for (const c in rooms) {
      if (rooms[c].players[socket.id]) leaveRoom(socket, c);
    }
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Salle introuvable' });
    if (room.started) return socket.emit('error', { msg: 'Partie déjà en cours' });
    if (Object.keys(room.players).length >= 8) return socket.emit('error', { msg: 'Salle pleine' });
    room.players[socket.id] = {
      id: socket.id, name: name || 'Joueur', color: color || '#4ecdc4',
      alive: true, survivalTime: 0, xpEarned: 0, coins: 0,
    };
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  socket.on('leave_room', ({ code }) => leaveRoom(socket, code));

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const seed = Math.floor(Math.random() * 999999);
    room.started = true;
    let spawnCount = 0;
    Object.values(room.players).forEach(p => { p.alive = true; p.survivalTime = 0; p.xpEarned = 0; p.coins = 0; });
    io.to(code).emit('game_start', {
      seed,
      players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color })),
      maxBalls: room.maxBalls, spawnRate: room.spawnRate,
    });
    broadcastPublicRooms();
    setTimeout(() => {
      if (!room.started) return;
      for (let i = 0; i < 3; i++) { io.to(code).emit('spawn_signal'); spawnCount++; }
    }, 3500);
    room.spawnInterval = setInterval(() => {
      if (!room.started || spawnCount >= room.maxBalls) return;
      io.to(code).emit('spawn_signal'); spawnCount++;
    }, room.spawnRate);
    room.coinInterval = setInterval(() => {
      if (!room.started) return;
      io.to(code).emit('coin_spawn', {
        coinId: Math.random().toString(36).slice(2),
        x: 60 + Math.random() * 680,
        y: 60 + Math.random() * 480,
      });
    }, 8000);
  });

  socket.on('mouse_pos', ({ code, x, y }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    socket.to(code).emit('player_moved', { id: socket.id, x, y });
  });

  socket.on('i_died', ({ code, survivalTime }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (!p.alive) return;
    p.alive = false; p.survivalTime = survivalTime; p.xpEarned = Math.floor(survivalTime * 2);
    io.to(code).emit('player_died', { id: socket.id, name: p.name, time: survivalTime });
    if (Object.values(room.players).filter(p => p.alive).length === 0) endRoom(room);
  });

  socket.on('coin_collected', ({ code, coinId }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].coins = (room.players[socket.id].coins || 0) + 1;
    io.to(code).emit('coin_taken', { coinId });
  });

  socket.on('ulti1', ({ code }) => socket.to(code).emit('speed_up_all'));
  socket.on('ulti2', ({ code }) => socket.to(code).emit('freeze_all'));

  socket.on('restart_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    clearInterval(room.spawnInterval); clearInterval(room.coinInterval);
    room.started = false;
    broadcastLobby(code); broadcastPublicRooms();
    io.to(code).emit('go_to_lobby');
  });

  socket.on('return_to_menu', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    io.to(code).emit('go_to_menu');
    cleanupRoom(code);
  });

  socket.on('get_rooms', () => socket.emit('public_rooms', getPublicRooms()));

  socket.on('disconnect', () => {
    for (const code in rooms) {
      if (rooms[code]?.players[socket.id]) leaveRoom(socket, code);
    }
  });
});

function endRoom(room) {
  clearInterval(room.spawnInterval); clearInterval(room.coinInterval);
  room.started = false;
  const scores = Object.values(room.players)
    .map(p => ({ id: p.id, name: p.name, color: p.color, time: p.survivalTime || 0, xp: p.xpEarned || 0, coins: p.coins || 0 }))
    .sort((a, b) => b.time - a.time);
  io.to(room.code).emit('game_over', { scores });
  broadcastPublicRooms();
}

server.listen(process.env.PORT || 3000, () => console.log('Server on port', process.env.PORT || 3000));
