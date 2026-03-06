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
      totalRounds: r.totalRounds,
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
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      trail: p.trail, emoji: p.emoji,
    })),
    hostId: room.host,
    isPrivate: room.isPrivate,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
  });
}

function cleanupRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearInterval(room.spawnInterval);
  clearInterval(room.coinInterval);
  clearInterval(room.laserInterval);
  clearInterval(room.shieldInterval);
  delete rooms[code];
  broadcastPublicRooms();
}

function leaveRoom(socket, code) {
  const room = rooms[code];
  if (!room || !room.players[socket.id]) return;
  const wasHost = room.host === socket.id;
  delete room.players[socket.id];
  socket.leave(code);
  if (Object.keys(room.players).length === 0) { cleanupRoom(code); return; }
  if (wasHost) {
    room.host = Object.keys(room.players)[0];
    io.to(code).emit('new_host', { hostId: room.host });
  }
  if (room.started) {
    if (Object.values(room.players).filter(p => p.alive).length === 0) endRound(room);
  } else {
    broadcastLobby(code);
  }
  broadcastPublicRooms();
}

io.on('connection', (socket) => {

  socket.on('create_room', ({ name, color, trail, emoji, isPrivate, maxBalls, spawnRate, totalRounds }) => {
    for (const c in rooms) if (rooms[c].players[socket.id]) leaveRoom(socket, c);
    const code = generateCode();
    rooms[code] = {
      code, isPrivate: !!isPrivate, host: socket.id,
      players: {}, started: false,
      spawnInterval: null, coinInterval: null, laserInterval: null, shieldInterval: null,
      maxBalls: maxBalls || 25,
      spawnRate: spawnRate || 10000,
      totalRounds: Math.min(10, Math.max(3, totalRounds || 3)),
      currentRound: 0,
      roundResults: [],
    };
    rooms[code].players[socket.id] = mkPlayer(socket.id, name, color, trail, emoji);
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  socket.on('join_room', ({ code, name, color, trail, emoji }) => {
    for (const c in rooms) if (rooms[c].players[socket.id]) leaveRoom(socket, c);
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Salle introuvable' });
    if (room.started) return socket.emit('error', { msg: 'Partie déjà en cours' });
    if (Object.keys(room.players).length >= 8) return socket.emit('error', { msg: 'Salle pleine' });
    room.players[socket.id] = mkPlayer(socket.id, name, color, trail, emoji);
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  socket.on('leave_room', ({ code }) => leaveRoom(socket, code));

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.started = true;
    room.currentRound = 0;
    Object.values(room.players).forEach(p => {
      p.totalCoins = 0; p.totalXP = 0; p.wins = 0;
      p.activeAbility = null; p.passiveAbility = null;
    });
    startRound(room);
  });

  socket.on('start_round', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    startRound(room);
  });

  socket.on('mouse_pos', ({ code, x, y }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    socket.to(code).emit('player_moved', { id: socket.id, x, y });
  });

  socket.on('i_died', ({ code, survivalTime, coinsThisRound }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    if (!p.alive) return;
    p.alive = false;
    p.survivalTime = survivalTime;
    p.xpThisRound = Math.floor(survivalTime * 2);
    p.coinsThisRound = coinsThisRound || 0;
    // Banquier: keep 50% coins even if died
    if (p.passiveAbility === 'banquier') p.coinsThisRound = Math.ceil(p.coinsThisRound);
    p.totalCoins += p.coinsThisRound;
    p.totalXP += p.xpThisRound;
    io.to(code).emit('player_died', { id: socket.id, name: p.name, time: survivalTime });
    if (Object.values(room.players).filter(p => p.alive).length === 0) endRound(room);
  });

  socket.on('round_winner', ({ code, survivalTime, coinsThisRound }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    p.alive = false;
    p.survivalTime = survivalTime;
    p.xpThisRound = Math.floor(survivalTime * 2);
    p.coinsThisRound = (coinsThisRound || 0) * 3; // winner x3 coins
    p.totalCoins += p.coinsThisRound;
    p.totalXP += p.xpThisRound;
    p.wins = (p.wins || 0) + 1;
    endRound(room);
  });

  socket.on('coin_collected', ({ code, coinId }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    io.to(code).emit('coin_taken', { coinId });
  });

  // Ability activations — broadcast to others
  socket.on('use_brouillard', ({ code }) => socket.to(code).emit('recv_brouillard'));
  socket.on('use_miroir', ({ code }) => socket.to(code).emit('recv_miroir'));
  socket.on('use_flash', ({ code }) => socket.to(code).emit('recv_flash'));
  socket.on('use_spectre', ({ code }) => socket.to(code).emit('recv_spectre', { id: socket.id }));

  socket.on('ability_chosen', ({ code, activeAbility, passiveAbility }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].activeAbility = activeAbility;
    room.players[socket.id].passiveAbility = passiveAbility;
    // Check if all players have chosen
    const allChosen = Object.values(room.players).every(p => p.activeAbility !== undefined);
    if (allChosen) io.to(code).emit('all_chosen');
  });

  socket.on('restart_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    clearRoomIntervals(room);
    room.started = false; room.currentRound = 0; room.roundResults = [];
    Object.values(room.players).forEach(p => {
      p.totalCoins=0;p.totalXP=0;p.wins=0;p.activeAbility=null;p.passiveAbility=null;
    });
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

function mkPlayer(id, name, color, trail, emoji) {
  return {
    id, name: name||'Joueur', color: color||'#ff6b6b',
    trail: trail||'none', emoji: emoji||'',
    alive: true, survivalTime: 0, xpThisRound: 0, coinsThisRound: 0,
    totalCoins: 0, totalXP: 0, wins: 0,
    activeAbility: null, passiveAbility: null,
  };
}

function clearRoomIntervals(room) {
  clearInterval(room.spawnInterval);
  clearInterval(room.coinInterval);
  clearInterval(room.laserInterval);
  clearInterval(room.shieldInterval);
}

function startRound(room) {
  clearRoomIntervals(room);
  room.currentRound++;
  const seed = Math.floor(Math.random() * 999999);
  let spawnCount = 0;

  Object.values(room.players).forEach(p => {
    p.alive = true; p.survivalTime = 0; p.xpThisRound = 0; p.coinsThisRound = 0;
  });

  io.to(room.code).emit('round_start', {
    seed,
    round: room.currentRound,
    totalRounds: room.totalRounds,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      trail: p.trail, emoji: p.emoji,
      activeAbility: p.activeAbility, passiveAbility: p.passiveAbility,
    })),
    maxBalls: room.maxBalls,
    spawnRate: room.spawnRate,
  });

  broadcastPublicRooms();

  // Initial balls
  setTimeout(() => {
    if (!room.started) return;
    for (let i = 0; i < 3; i++) { io.to(room.code).emit('spawn_signal'); spawnCount++; }
  }, 3500);

  // Ball spawner
  room.spawnInterval = setInterval(() => {
    if (!room.started || spawnCount >= room.maxBalls) return;
    io.to(room.code).emit('spawn_signal'); spawnCount++;
  }, room.spawnRate);

  // Coins every 8s
  room.coinInterval = setInterval(() => {
    if (!room.started) return;
    io.to(room.code).emit('coin_spawn', {
      coinId: Math.random().toString(36).slice(2),
      x: 60 + Math.random() * 680,
      y: 60 + Math.random() * 480,
    });
  }, 8000);

  // Laser every 20s
  room.laserInterval = setInterval(() => {
    if (!room.started) return;
    const isHorizontal = Math.random() > 0.5;
    const position = isHorizontal
      ? Math.floor(50 + Math.random() * 500)
      : Math.floor(50 + Math.random() * 700);
    io.to(room.code).emit('laser_warning', { isHorizontal, position });
    setTimeout(() => {
      io.to(room.code).emit('laser_fire', { isHorizontal, position });
    }, 1000);
  }, 20000);

  // Shield powerup every 15s
  room.shieldInterval = setInterval(() => {
    if (!room.started) return;
    io.to(room.code).emit('shield_spawn', {
      shieldId: Math.random().toString(36).slice(2),
      x: 60 + Math.random() * 680,
      y: 60 + Math.random() * 480,
    });
  }, 15000);
}

function endRound(room) {
  clearRoomIntervals(room);

  const results = Object.values(room.players)
    .map(p => ({
      id: p.id, name: p.name, color: p.color, emoji: p.emoji,
      time: p.survivalTime || 0,
      xp: p.xpThisRound || 0,
      coins: p.coinsThisRound || 0,
      wins: p.wins || 0,
      activeAbility: p.activeAbility,
      passiveAbility: p.passiveAbility,
    }))
    .sort((a, b) => b.time - a.time);

  room.roundResults.push(results);

  const isLastRound = room.currentRound >= room.totalRounds;

  io.to(room.code).emit('round_over', {
    results,
    round: room.currentRound,
    totalRounds: room.totalRounds,
    isLastRound,
  });
}

server.listen(process.env.PORT || 3000, () => console.log('Server on port', process.env.PORT || 3000));
