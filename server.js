const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

const rooms = {};

function genCode() {
  return Math.random().toString(36).substring(2,7).toUpperCase();
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
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      trail: p.trail, emoji: p.emoji, level: p.level || 1,
    })),
    hostId: room.host,
    isPrivate: room.isPrivate,
    totalRounds: room.totalRounds,
    settings: room.settings,
  });
}

function clearIntervals(room) {
  clearInterval(room.spawnInterval);
  clearInterval(room.coinInterval);
  clearInterval(room.laserInterval);
}

function cleanupRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearIntervals(room);
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
    const alive = Object.values(room.players).filter(p => p.alive);
    if (alive.length <= 1) endRound(room);
  } else {
    broadcastLobby(code);
  }
  broadcastPublicRooms();
}

function mkPlayer(id, name, color, trail, emoji, level) {
  return {
    id, name: name||'Joueur', color: color||'#ff6b6b',
    trail: trail||'none', emoji: emoji||'', level: level||1,
    alive: true, survivalTime: 0,
    xpThisRound: 0, coinsThisRound: 0,
    totalXP: 0, totalCoins: 0, wins: 0,
    activeAbility: null, passives: [],
    ready: false,
  };
}

io.on('connection', socket => {

  socket.on('create_room', ({ name, color, trail, emoji, level, isPrivate, totalRounds, maxBalls, spawnRate, settings }) => {
    for (const c in rooms) if (rooms[c].players[socket.id]) leaveRoom(socket, c);
    const code = genCode();
    rooms[code] = {
      code, isPrivate: !!isPrivate,
      host: socket.id, players: {},
      started: false, currentRound: 0, totalRounds: Math.min(10, Math.max(3, totalRounds||3)),
      roundResults: [],
      spawnInterval: null, coinInterval: null, laserInterval: null,
      maxBalls: maxBalls||20,
      spawnRate: spawnRate||10000,
      roundStartTime: 0,
      settings: settings || defaultSettings(),
    };
    rooms[code].players[socket.id] = mkPlayer(socket.id, name, color, trail, emoji, level);
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastLobby(code);
    broadcastPublicRooms();
  });

  socket.on('join_room', ({ code, name, color, trail, emoji, level }) => {
    for (const c in rooms) if (rooms[c].players[socket.id]) leaveRoom(socket, c);
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Salle introuvable' });
    if (room.started) return socket.emit('error', { msg: 'Partie en cours' });
    if (Object.keys(room.players).length >= 8) return socket.emit('error', { msg: 'Salle pleine' });
    room.players[socket.id] = mkPlayer(socket.id, name, color, trail, emoji, level);
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
      p.totalXP = 0; p.totalCoins = 0; p.wins = 0;
      p.activeAbility = null; p.passives = []; p.ready = false;
    });
    io.to(code).emit('show_ability_select', { isFirstRound: true });
  });

  socket.on('ability_ready', ({ code, activeAbility, passives }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    p.activeAbility = activeAbility;
    p.passives = passives || [];
    p.ready = true;
    const total = Object.keys(room.players).length;
    const readyCount = Object.values(room.players).filter(x => x.ready).length;
    io.to(code).emit('ready_count', { ready: readyCount, total });
    if (readyCount === total) {
      Object.values(room.players).forEach(p => p.ready = false);
      startRound(room);
    }
  });

  socket.on('next_round', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    io.to(code).emit('show_ability_select', { isFirstRound: false });
  });

  socket.on('player_input', ({ code, keys }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    socket.to(code).emit('player_input_update', { id: socket.id, keys });
  });

  socket.on('player_pos', ({ code, x, y }) => {
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
    p.totalXP += p.xpThisRound;
    p.totalCoins += p.coinsThisRound;
    io.to(code).emit('player_died', { id: socket.id, name: p.name, time: survivalTime });
    const alive = Object.values(room.players).filter(p => p.alive);
    if (alive.length === 0) { endRound(room); return; }
    if (alive.length === 1) {
      const winner = alive[0];
      winner.alive = false;
      winner.survivalTime = (Date.now() - room.roundStartTime) / 1000;
      winner.xpThisRound = Math.floor(winner.survivalTime * 2);
      winner.wins = (winner.wins || 0) + 1;
      // Winner keeps all coins undivided
      winner.coinsThisRound = winner.coinsThisRound || 0;
      winner.totalXP += winner.xpThisRound;
      winner.totalCoins += winner.coinsThisRound;
      io.to(code).emit('player_died', { id: winner.id, name: winner.name, time: winner.survivalTime, isWinner: true });
      endRound(room);
    }
  });

  socket.on('coin_collected', ({ code, coinId }) => {
    socket.to(code).emit('coin_taken', { coinId });
  });

  socket.on('use_active', ({ code, ability }) => {
    socket.to(code).emit('recv_active', { id: socket.id, ability });
  });

  socket.on('restart_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    clearIntervals(room);
    room.started = false; room.currentRound = 0; room.roundResults = [];
    Object.values(room.players).forEach(p => {
      p.totalXP=0; p.totalCoins=0; p.wins=0;
      p.activeAbility=null; p.passives=[]; p.ready=false;
    });
    io.to(code).emit('go_to_lobby');
    broadcastLobby(code);
    broadcastPublicRooms();
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

function defaultSettings() {
  return {
    lasersEnabled: true,
    laserFrequency: 20000,
    laserMaxSimultaneous: 2,
    laserWarningDuration: 1500,
    laserDiagonal: true,
  };
}

function startRound(room) {
  clearIntervals(room);
  room.currentRound++;
  room.roundStartTime = Date.now();
  const seed = Math.floor(Math.random() * 999999);
  let spawnCount = 0;

  Object.values(room.players).forEach(p => {
    p.alive = true; p.survivalTime = 0;
    p.xpThisRound = 0; p.coinsThisRound = 0;
  });

  io.to(room.code).emit('round_start', {
    seed,
    round: room.currentRound,
    totalRounds: room.totalRounds,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      trail: p.trail, emoji: p.emoji, level: p.level,
      activeAbility: p.activeAbility, passives: p.passives,
    })),
    settings: room.settings,
  });

  broadcastPublicRooms();

  // Initial spawn
  setTimeout(() => {
    if (!rooms[room.code]?.started) return;
    for (let i = 0; i < 3; i++) {
      io.to(room.code).emit('spawn_signal');
      spawnCount++;
    }
  }, 3500);

  // Spawn interval
  room.spawnInterval = setInterval(() => {
    if (!rooms[room.code]?.started) return;
    if (spawnCount >= room.maxBalls) return;
    io.to(room.code).emit('spawn_signal');
    spawnCount++;
  }, room.spawnRate);

  // Coins
  room.coinInterval = setInterval(() => {
    if (!rooms[room.code]?.started) return;
    io.to(room.code).emit('coin_spawn', {
      coinId: Math.random().toString(36).slice(2),
      x: 60 + Math.random() * 680,
      y: 60 + Math.random() * 480,
    });
  }, 7000);

  // Lasers
  const s = room.settings;
  if (s.lasersEnabled) {
    let active = 0;
    room.laserInterval = setInterval(() => {
      if (!rooms[room.code]?.started) return;
      if (active >= s.laserMaxSimultaneous) return;
      const types = ['horizontal', 'vertical'];
      if (s.laserDiagonal) types.push('diagonal45', 'diagonal135');
      const type = types[Math.floor(Math.random() * types.length)];
      const position = Math.floor(80 + Math.random() * 640);
      active++;
      io.to(room.code).emit('laser_warning', { type, position, duration: s.laserWarningDuration });
      setTimeout(() => {
        if (!rooms[room.code]?.started) return;
        io.to(room.code).emit('laser_fire', { type, position });
        setTimeout(() => { active = Math.max(0, active - 1); }, 600);
      }, s.laserWarningDuration);
    }, s.laserFrequency);
  }
}

function endRound(room) {
  clearIntervals(room);
  const playerCount = Object.keys(room.players).length;

  // Coin dividers based on rank
  const dividers = [];
  for (let i = 0; i < playerCount; i++) {
    if (i === 0) dividers.push(1);
    else dividers.push(1 + i * 0.5);
  }

  const sorted = Object.values(room.players)
    .sort((a, b) => b.survivalTime - a.survivalTime);

  sorted.forEach((p, i) => {
    if (i > 0) { // winner keeps all
      p.coinsThisRound = Math.floor(p.coinsThisRound / dividers[i]);
      p.totalCoins = (p.totalCoins || 0) - (p.coinsThisRound * dividers[i] - p.coinsThisRound);
    }
  });

  const results = sorted.map(p => ({
    id: p.id, name: p.name, color: p.color, emoji: p.emoji,
    time: p.survivalTime || 0,
    xp: p.xpThisRound || 0,
    coins: p.coinsThisRound || 0,
    wins: p.wins || 0,
    activeAbility: p.activeAbility,
    passives: p.passives || [],
  }));

  room.roundResults.push(results);
  const isLastRound = room.currentRound >= room.totalRounds;

  io.to(room.code).emit('round_over', {
    results, round: room.currentRound,
    totalRounds: room.totalRounds, isLastRound,
  });

  if (isLastRound) {
    const finals = Object.values(room.players)
      .map(p => ({ id:p.id, name:p.name, color:p.color, emoji:p.emoji,
        wins:p.wins||0, totalXP:p.totalXP||0, totalCoins:p.totalCoins||0 }))
      .sort((a,b) => b.wins - a.wins || b.totalXP - a.totalXP);
    setTimeout(() => io.to(room.code).emit('game_over', { results: finals }), 4000);
  }
}

server.listen(process.env.PORT || 3000, () => console.log('Server running on port', process.env.PORT || 3000));
