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
    maxBalls: room.maxBalls,
    spawnRate: room.spawnRate,
  });
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ name, color, isPrivate, maxBalls, spawnRate }) => {
    const code = generateCode();
    rooms[code] = {
      code,
      isPrivate: !!isPrivate,
      host: socket.id,
      players: {},
      started: false,
      seed: null,
      startTime: null,
      spawnInterval: null,
      maxBalls: maxBalls || 25,
      spawnRate: spawnRate || 10000,
    };
    rooms[code].players[socket.id] = {
      id: socket.id, name: name || 'Joueur', color: color || '#ff6b6b',
      x: 0, y: 0, alive: true, survivalTime: 0, xpEarned: 0,
    };
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  socket.on('join_room', ({ code, name, color }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Salle introuvable' });
    if (room.started) return socket.emit('error', { msg: 'Partie déjà en cours' });
    if (Object.keys(room.players).length >= 8) return socket.emit('error', { msg: 'Salle pleine (max 8)' });
    room.players[socket.id] = {
      id: socket.id, name: name || 'Joueur', color: color || '#4ecdc4',
      x: 0, y: 0, alive: true, survivalTime: 0, xpEarned: 0,
    };
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;

    room.started = true;
    room.seed = generateSeed();
    room.startTime = Date.now();

    Object.values(room.players).forEach(p => {
      p.alive = true;
      p.survivalTime = 0;
      p.xpEarned = 0;
    });

    // Send SAME seed + SAME startTime to all — this ensures identical simulation
    io.to(code).emit('game_start', {
      seed: room.seed,
      serverStartTime: room.startTime,
      players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color })),
      maxBalls: room.maxBalls,
      spawnRate: room.spawnRate,
    });

    broadcastPublicRooms();

    // Spawn signals at fixed server timestamps — clients use elapsed time to stay in sync
    let spawnCount = 0;

    // Initial 3 balls after countdown
    setTimeout(() => {
      if (!room.started) return;
      for (let i = 0; i < 3; i++) {
        io.to(code).emit('spawn_signal', { elapsed: (Date.now() - room.startTime) / 1000 });
      }
      spawnCount = 3;
    }, 3500);

    // Then every spawnRate ms
    room.spawnInterval = setInterval(() => {
      if (!room.started || spawnCount >= room.maxBalls) return;
      io.to(code).emit('spawn_signal', { elapsed: (Date.now() - room.startTime) / 1000 });
      spawnCount++;
    }, room.spawnRate);

    // Coin spawns every 8s
    room.coinInterval = setInterval(() => {
      if (!room.started) return;
      io.to(code).emit('coin_spawn', {
        elapsed: (Date.now() - room.startTime) / 1000,
      });
    }, 8000);
  });

  socket.on('mouse_pos', ({ code, x, y }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].x = x;
    room.players[socket.id].y = y;
    socket.to(code).emit('player_moved', { id: socket.id, x, y });
  });

  socket.on('i_died', ({ code, survivalTime }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (!p.alive) return;
    p.alive = false;
    p.survivalTime = survivalTime;
    p.xpEarned = Math.floor(survivalTime * 2);
    io.to(code).emit('player_died', { id: socket.id, name: p.name, time: survivalTime });

    const alive = Object.values(room.players).filter(p => p.alive);
    if (alive.length === 0) endRoom(room);
  });

  socket.on('coin_collected', ({ code, coinId, coins }) => {
    // Broadcast to others so they remove the coin too
    socket.to(code).emit('coin_taken', { coinId });
    // Update player coins
    const room = rooms[code];
    if (room && room.players[socket.id]) {
      room.players[socket.id].coins = (room.players[socket.id].coins || 0) + 1;
    }
    io.to(code).emit('coin_update', {
      id: socket.id,
      name: room?.players[socket.id]?.name || '?',
      coins,
    });
  });

  socket.on('ulti2', ({ code }) => {
    // Broadcast freeze to all clients
    socket.to(code).emit('freeze_all');
  });

  socket.on('return_to_menu', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    io.to(code).emit('go_to_menu');
    clearInterval(room.spawnInterval);
    clearInterval(room.coinInterval);
    delete rooms[code];
    broadcastPublicRooms();
  });

  socket.on('restart_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    clearInterval(room.spawnInterval);
    clearInterval(room.coinInterval);
    room.started = false;
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  socket.on('get_rooms', () => {
    socket.emit('public_rooms', getPublicRooms());
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (!room.players[socket.id]) continue;
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) {
        clearInterval(room.spawnInterval);
        clearInterval(room.coinInterval);
        delete rooms[code];
      } else {
        if (room.host === socket.id) room.host = Object.keys(room.players)[0];
        if (room.started) {
          const alive = Object.values(room.players).filter(p => p.alive);
          if (alive.length === 0) endRoom(room);
        } else {
          broadcastLobby(code);
        }
      }
      broadcastPublicRooms();
    }
  });
});

function endRoom(room) {
  clearInterval(room.spawnInterval);
  clearInterval(room.coinInterval);
  room.started = false;
  const scores = Object.values(room.players)
    .map(p => ({ id: p.id, name: p.name, color: p.color, time: p.survivalTime || 0, xp: p.xpEarned || 0, coins: p.coins || 0 }))
    .sort((a, b) => b.time - a.time);
  io.to(room.code).emit('game_over', { scores });
  broadcastPublicRooms();
}

server.listen(process.env.PORT || 3000, () => console.log('Server on port', process.env.PORT || 3000));
