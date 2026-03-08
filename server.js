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

function clearAllIntervals(room) {
  clearInterval(room.waveInterval);
  clearInterval(room.coinInterval);
  clearInterval(room.laserInterval);
  clearInterval(room.zoneInterval);
  clearTimeout(room.waveTimeout);
}

function cleanupRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearAllIntervals(room);
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
  broadcastLobby(code);
  broadcastPublicRooms();
}

function mkPlayer(id, name, color, trail, emoji, level) {
  return {
    id, name: name||'Joueur', color: color||'#c77dff',
    trail: trail||'none', emoji: emoji||'', level: level||1,
    alive: true, survivalTime: 0,
    xpThisRound: 0, coinsThisRound: 0,
    totalXP: 0, totalCoins: 0, wins: 0,
    activeAbility: null, passives: [],
    ready: false,
  };
}

function defaultSettings() {
  return {
    lasersEnabled: true,
    laserFrequency: 20000,
    laserMaxSimultaneous: 2,
    laserWarningDuration: 1800,
    laserDiagonal: true,
    zonesEnabled: true,
    waveDuration: 20000,      // duration of each wave phase
    waveResetDuration: 4000,  // pause between waves
    maxBallsPerWave: 6,
    ballSpawnRate: 3000,
    zoneSpawnRate: 8000,
  };
}

io.on('connection', socket => {

  socket.on('create_room', ({ name, color, trail, emoji, level, isPrivate, totalRounds, settings }) => {
    for (const c in rooms) if (rooms[c].players[socket.id]) leaveRoom(socket, c);
    const code = genCode();
    const merged = Object.assign(defaultSettings(), settings || {});
    rooms[code] = {
      code, isPrivate: !!isPrivate,
      host: socket.id, players: {},
      started: false, currentRound: 0,
      totalRounds: Math.min(10, Math.max(3, totalRounds||3)),
      roundResults: [],
      waveInterval: null, coinInterval: null,
      laserInterval: null, zoneInterval: null,
      waveTimeout: null,
      settings: merged,
      currentWave: 0,
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
    // Reset all abilities at game start
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
    p.activeAbility = activeAbility || null;
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

    // Check if ALL players are dead
    const alive = Object.values(room.players).filter(p => p.alive);
    if (alive.length === 0) {
      endRound(room);
    }
    // If only 1 left, they win the round
    if (alive.length === 1) {
      const winner = alive[0];
      winner.alive = false;
      winner.survivalTime = parseFloat(((Date.now() - room.roundStartTime) / 1000).toFixed(1));
      winner.xpThisRound = Math.floor(winner.survivalTime * 2);
      winner.wins = (winner.wins || 0) + 1;
      winner.totalXP += winner.xpThisRound;
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
    clearAllIntervals(room);
    room.started = false; room.currentRound = 0; room.roundResults = [];
    // Full reset of abilities
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

// ══ WAVE SYSTEM ══
function startRound(room) {
  clearAllIntervals(room);
  room.currentRound++;
  room.roundStartTime = Date.now();
  room.currentWave = 0;
  const seed = Math.floor(Math.random() * 999999);

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

  // Coins interval — always active
  room.coinInterval = setInterval(() => {
    if (!rooms[room.code]?.started) return;
    io.to(room.code).emit('coin_spawn', {
      coinId: Math.random().toString(36).slice(2),
      x: 80 + Math.random() * 640,
      y: 80 + Math.random() * 440,
    });
  }, 7000);

  // Start wave loop after countdown (3.5s)
  setTimeout(() => {
    if (!rooms[room.code]?.started) return;
    runWave(room);
  }, 3500);
}

function runWave(room) {
  if (!rooms[room.code]?.started) return;
  room.currentWave++;
  const s = room.settings;
  const wave = ((room.currentWave - 1) % 3) + 1; // cycles 1→2→3→1→2→3

  io.to(room.code).emit('wave_start', { wave, waveNumber: room.currentWave });

  // Clear previous wave entities
  io.to(room.code).emit('wave_clear');

  // Wave 1: balls only
  if (wave === 1) {
    let spawned = 0;
    // Initial burst
    const burst = Math.min(3, s.maxBallsPerWave);
    for (let i = 0; i < burst; i++) {
      setTimeout(() => io.to(room.code).emit('spawn_signal'), i * 400);
      spawned++;
    }
    room.waveInterval = setInterval(() => {
      if (!rooms[room.code]?.started) return;
      if (spawned >= s.maxBallsPerWave) return;
      io.to(room.code).emit('spawn_signal');
      spawned++;
    }, s.ballSpawnRate);
  }

  // Wave 2: zones only (balls cleared)
  if (wave === 2 && s.zonesEnabled) {
    spawnZoneWave(room);
    room.zoneInterval = setInterval(() => {
      if (!rooms[room.code]?.started) return;
      spawnZoneWave(room);
    }, s.zoneSpawnRate);
  }

  // Wave 3: everything
  if (wave === 3) {
    let spawned = 0;
    const burst = Math.min(2, s.maxBallsPerWave);
    for (let i = 0; i < burst; i++) {
      setTimeout(() => io.to(room.code).emit('spawn_signal'), i * 600);
      spawned++;
    }
    room.waveInterval = setInterval(() => {
      if (!rooms[room.code]?.started) return;
      if (spawned >= s.maxBallsPerWave) return;
      io.to(room.code).emit('spawn_signal');
      spawned++;
    }, s.ballSpawnRate + 1000);
    if (s.zonesEnabled) {
      spawnZoneWave(room);
      room.zoneInterval = setInterval(() => {
        if (!rooms[room.code]?.started) return;
        spawnZoneWave(room);
      }, s.zoneSpawnRate + 2000);
    }
    if (s.lasersEnabled) {
      startLasers(room);
    }
  }

  // Schedule next wave
  room.waveTimeout = setTimeout(() => {
    if (!rooms[room.code]?.started) return;
    clearInterval(room.waveInterval);
    clearInterval(room.zoneInterval);
    clearInterval(room.laserInterval);
    // Brief reset pause
    io.to(room.code).emit('wave_reset');
    setTimeout(() => {
      if (!rooms[room.code]?.started) return;
      runWave(room);
    }, s.waveResetDuration);
  }, s.waveDuration);
}

function spawnZoneWave(room) {
  const types = ['poison', 'fire', 'blackhole', 'electricwall'];
  const type = types[Math.floor(Math.random() * types.length)];
  const zoneId = Math.random().toString(36).slice(2);
  let data = { zoneId, type };

  if (type === 'poison' || type === 'fire' || type === 'blackhole') {
    data.x = 100 + Math.random() * 600;
    data.y = 100 + Math.random() * 400;
    data.r = type === 'blackhole' ? 40 : (60 + Math.random() * 60);
  } else if (type === 'electricwall') {
    data.isHorizontal = Math.random() > 0.5;
    data.startEdge = Math.random() > 0.5 ? 0 : 1; // 0=top/left, 1=bottom/right
    data.speed = 40 + Math.random() * 40; // px/sec
  }

  const duration = 20000 + Math.random() * 10000;
  data.duration = duration;

  io.to(room.code).emit('zone_spawn', data);
  setTimeout(() => {
    if (!rooms[room.code]?.started) return;
    io.to(room.code).emit('zone_expire', { zoneId });
  }, duration);
}

function startLasers(room) {
  const s = room.settings;
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

function endRound(room) {
  clearAllIntervals(room);
  const playerCount = Object.keys(room.players).length;

  // Coin dividers by rank
  const sorted = Object.values(room.players)
    .sort((a, b) => b.survivalTime - a.survivalTime);

  sorted.forEach((p, i) => {
    if (i === 0) return; // winner keeps all
    const div = 1 + i * 0.5;
    p.coinsThisRound = Math.floor(p.coinsThisRound / div);
  });

  const results = sorted.map(p => ({
    id: p.id, name: p.name, color: p.color, emoji: p.emoji,
    time: p.survivalTime || 0,
    xp: p.xpThisRound || 0,
    coins: p.coinsThisRound || 0,
    wins: p.wins || 0,
  }));

  room.roundResults.push(results);
  const isLastRound = room.currentRound >= room.totalRounds;

  io.to(room.code).emit('round_over', {
    results, round: room.currentRound,
    totalRounds: room.totalRounds, isLastRound,
  });

  if (isLastRound) {
    const finals = Object.values(room.players)
      .map(p => ({
        id: p.id, name: p.name, color: p.color, emoji: p.emoji,
        wins: p.wins||0, totalXP: p.totalXP||0, totalCoins: p.totalCoins||0,
      }))
      .sort((a,b) => b.wins - a.wins || b.totalXP - a.totalXP);
    setTimeout(() => io.to(room.code).emit('game_over', { results: finals }), 4000);
  }
}

server.listen(process.env.PORT || 3000, () =>
  console.log('Ball Arena v4.1 running on port', process.env.PORT || 3000));
