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
  clearInterval(room.spawnInterval);
  clearInterval(room.coinInterval);
  clearInterval(room.laserInterval);
  clearTimeout(room.graceTimeout);
  // Per-zone intervals
  for (const key of Object.keys(room)) {
    if (key.startsWith('zoneInterval_')) clearInterval(room[key]);
  }
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
    // Balls
    ballSpawnRate: 2000,
    ballLifespan: 20000,   // null = infinite
    maxBallsPerWave: 8,
    // Lasers
    lasersEnabled: true,
    laserFrequency: 12000,
    laserMaxSimultaneous: 2,
    laserWarningDuration: 1800,
    laserDiagonal: true,
    // Zones global toggle
    zonesEnabled: true,
    // Per-zone settings
    zones: {
      poison: {
        enabled: true,
        spawnRate: 10000,
        duration: 20000,
        radius: 70,
        poisonDelay: 1500,
      },
      fire: {
        enabled: true,
        spawnRate: 12000,
        duration: 15000,
        radius: 50,
      },
      blackhole: {
        enabled: true,
        spawnRate: 15000,
        duration: 18000,
        force: 60,
        range: 200,
      },
      electricwall: {
        enabled: true,
        spawnRate: 18000,
        speed: 60,
        gap: 90,
      },
    },
  };
}

io.on('connection', socket => {

  socket.on('create_room', ({ name, color, trail, emoji, level, isPrivate, totalRounds, settings }) => {
    for (const c in rooms) if (rooms[c].players[socket.id]) leaveRoom(socket, c);
    const code = genCode();
    // Deep merge settings with defaults
    const def = defaultSettings();
    const merged = Object.assign({}, def, settings || {});
    // Merge nested zones
    if (settings?.zones) {
      merged.zones = {};
      for (const zType of ['poison', 'fire', 'blackhole', 'electricwall']) {
        merged.zones[zType] = Object.assign({}, def.zones[zType], settings.zones[zType] || {});
      }
    }
    rooms[code] = {
      code, isPrivate: !!isPrivate,
      host: socket.id, players: {},
      started: false, currentRound: 0,
      totalRounds: Math.min(10, Math.max(3, totalRounds||3)),
      roundResults: [],
      spawnInterval: null, coinInterval: null, laserInterval: null,
      roundStartTime: 0,
      settings: merged,
      ballCount: 0,
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

    const alive = Object.values(room.players).filter(p => p.alive);

    if (alive.length === 0) {
      endRound(room);
    } else if (alive.length === 1) {
      // Last survivor: 25s grace period to collect coins, then end
      const winner = alive[0];
      io.to(code).emit('last_player_standing', { id: winner.id, name: winner.name, graceSeconds: 25 });
      // Cancel any existing grace timer
      clearTimeout(room.graceTimeout);
      room.graceTimeout = setTimeout(() => {
        if (!rooms[code]?.started) return;
        winner.alive = false;
        winner.survivalTime = parseFloat(((Date.now() - room.roundStartTime) / 1000).toFixed(1));
        winner.xpThisRound = Math.floor(winner.survivalTime * 2);
        winner.wins = (winner.wins || 0) + 1;
        winner.totalXP += winner.xpThisRound;
        io.to(code).emit('player_died', { id: winner.id, name: winner.name, time: winner.survivalTime, isWinner: true });
        endRound(room);
      }, 25000);
    }
  });

  // Winner sends final coins when grace period ends (or they can send earlier)
  socket.on('grace_done', ({ code, coinsThisRound }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const p = room.players[socket.id];
    p.coinsThisRound = coinsThisRound || p.coinsThisRound;
    p.totalCoins = (p.totalCoins || 0);
    // Force end now
    clearTimeout(room.graceTimeout);
    p.alive = false;
    p.survivalTime = parseFloat(((Date.now() - room.roundStartTime) / 1000).toFixed(1));
    p.xpThisRound = Math.floor(p.survivalTime * 2);
    p.wins = (p.wins || 0) + 1;
    p.totalXP += p.xpThisRound;
    io.to(code).emit('player_died', { id: socket.id, name: p.name, time: p.survivalTime, isWinner: true });
    endRound(room);
  });

  socket.on('coin_collected', ({ code, coinId }) => {
    const room = rooms[code];
    if (room) room.activeCoins = Math.max(0, (room.activeCoins || 0) - 1);
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

// ══ ROUND ══
function startRound(room) {
  clearAllIntervals(room);
  room.currentRound++;
  room.roundStartTime = Date.now();
  room.ballCount = 0;
  const seed = Math.floor(Math.random() * 999999);
  const s = room.settings;

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

  // ── Balls: continuous spawn after countdown ──
  setTimeout(() => {
    if (!rooms[room.code]?.started) return;
    // Initial burst of 3
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (!rooms[room.code]?.started) return;
        io.to(room.code).emit('spawn_signal');
        room.ballCount++;
      }, i * 500);
    }
    // Ongoing spawn
    room.spawnInterval = setInterval(() => {
      if (!rooms[room.code]?.started) return;
      if (room.ballCount >= s.maxBallsPerWave) return;
      io.to(room.code).emit('spawn_signal');
      room.ballCount++;
      // If lifespan set, decrement count after lifespan so new ones can spawn
      if (s.ballLifespan) {
        setTimeout(() => { room.ballCount = Math.max(0, room.ballCount - 1); }, s.ballLifespan);
      }
    }, s.ballSpawnRate);
  }, 3500);

  // ── Coins: max 5 at once, no expiry ──
  room.activeCoins = 0;
  room.coinInterval = setInterval(() => {
    if (!rooms[room.code]?.started) return;
    if (room.activeCoins >= 5) return;
    room.activeCoins++;
    io.to(room.code).emit('coin_spawn', {
      coinId: Math.random().toString(36).slice(2),
      x: 80 + Math.random() * 640,
      y: 80 + Math.random() * 440,
    });
  }, 5000);

  // ── Lasers ──
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

  // ── Zones: each type has its own independent interval ──
  if (s.zonesEnabled) {
    const zTypes = ['poison', 'fire', 'blackhole', 'electricwall'];
    zTypes.forEach(zType => {
      const zc = s.zones?.[zType];
      if (!zc?.enabled) return;
      // Initial delay: stagger zone types so they don't all appear at once
      const stagger = { poison: 5000, fire: 8000, blackhole: 12000, electricwall: 16000 };
      setTimeout(() => {
        if (!rooms[room.code]?.started) return;
        spawnZone(room, zType);
        room[`zoneInterval_${zType}`] = setInterval(() => {
          if (!rooms[room.code]?.started) return;
          spawnZone(room, zType);
        }, zc.spawnRate);
      }, stagger[zType]);
    });
  }
}

// ── Spawn a single zone ──
function spawnZone(room, type) {
  if (!rooms[room.code]?.started) return;
  const s = room.settings;
  const zc = s.zones?.[type];
  if (!zc) return;

  const zoneId = Math.random().toString(36).slice(2);
  let data = { zoneId, type };

  if (type === 'poison') {
    data.x = 100 + Math.random() * 600;
    data.y = 100 + Math.random() * 400;
    data.r = zc.radius || 70;
    data.poisonDelay = zc.poisonDelay || 1500;
    data.duration = zc.duration || 20000;
  } else if (type === 'fire') {
    data.x = 100 + Math.random() * 600;
    data.y = 100 + Math.random() * 400;
    data.r = zc.radius || 50;
    data.duration = zc.duration || 15000;
  } else if (type === 'blackhole') {
    data.x = 150 + Math.random() * 500;
    data.y = 150 + Math.random() * 300;
    data.r = 40;
    data.force = zc.force || 60;
    data.range = zc.range || 200;
    data.duration = zc.duration || 18000;
  } else if (type === 'electricwall') {
    data.isHorizontal = Math.random() > 0.5;
    data.startEdge = Math.random() > 0.5 ? 0 : 1;
    data.speed = zc.speed || 60;
    data.gap = zc.gap || 90;
    // gapCenter: random position along the wall axis, avoid edges
    const axis = data.isHorizontal ? 800 : 600;
    data.gapCenter = axis * 0.2 + Math.random() * axis * 0.6;
    // Duration: time for wall to fully cross the arena
    const arenaSize = data.isHorizontal ? 600 : 800;
    data.duration = Math.ceil((arenaSize + 30) / data.speed * 1000) + 500;
  }

  io.to(room.code).emit('zone_spawn', data);

  // Auto-expire
  if (data.duration) {
    setTimeout(() => {
      if (!rooms[room.code]?.started) return;
      io.to(room.code).emit('zone_expire', { zoneId });
    }, data.duration);
  }
}

function endRound(room) {
  clearAllIntervals(room);

  const sorted = Object.values(room.players)
    .sort((a, b) => b.survivalTime - a.survivalTime);

  // Coin dividers by rank — winner keeps all, others divided
  sorted.forEach((p, i) => {
    if (i === 0) return; // winner keeps all
    const div = 1 + i * 0.5;
    p.coinsThisRound = Math.floor((p.coinsThisRound || 0) / div);
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
  console.log('Ball Arena v4.2 running on port', process.env.PORT || 3000));
