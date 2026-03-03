const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

const ARENA_W = 800;
const ARENA_H = 600;
const PLAYER_R = 14;
const TICK = 1000 / 30;
const SPAWN_INTERVAL = 10000;
const MAX_DANGER = 30;

const rooms = {};

function createDangerBall() {
  const angle = Math.random() * Math.PI * 2;
  const speed = 3 + Math.random() * 3;
  const types = ['normal','normal','normal','fast','big','split'];
  const type = types[Math.floor(Math.random() * types.length)];
  const r = type === 'big' ? 22 : 12;
  const spd = type === 'fast' ? speed * 1.8 : speed;
  return {
    id: Math.random().toString(36).slice(2),
    x: 100 + Math.random() * (ARENA_W - 200),
    y: 100 + Math.random() * (ARENA_H - 200),
    vx: Math.cos(angle) * spd,
    vy: Math.sin(angle) * spd,
    r, type,
    color: type === 'fast' ? '#ff4757' : type === 'big' ? '#ff6348' : type === 'split' ? '#eccc68' : '#ff6b81',
    frozen: false,
  };
}

function createRoom(code) {
  return { code, players: {}, dangerBalls: [], started: false, spawnTimer: null, tickTimer: null, startTime: null };
}

function startRoom(room) {
  room.started = true;
  room.startTime = Date.now();
  for (let i = 0; i < 3; i++) room.dangerBalls.push(createDangerBall());

  room.spawnTimer = setInterval(() => {
    if (room.dangerBalls.length < MAX_DANGER) {
      const count = Math.floor(room.dangerBalls.length / 8) + 1;
      for (let i = 0; i < count; i++) room.dangerBalls.push(createDangerBall());
    }
  }, SPAWN_INTERVAL);

  room.tickTimer = setInterval(() => {
    if (!room.started) return;

    room.dangerBalls.forEach(b => {
      const sm = b.frozen ? 0.1 : 1;
      b.x += b.vx * sm; b.y += b.vy * sm;
      if (b.x - b.r < 0) { b.x = b.r; b.vx *= -1; }
      if (b.x + b.r > ARENA_W) { b.x = ARENA_W - b.r; b.vx *= -1; }
      if (b.y - b.r < 0) { b.y = b.r; b.vy *= -1; }
      if (b.y + b.r > ARENA_H) { b.y = ARENA_H - b.r; b.vy *= -1; }
    });

    Object.values(room.players).forEach(p => {
      if (!p.alive) return;
      const spd = p.dashing ? 18 : 4;
      if (p.keys.up)    p.y = Math.max(PLAYER_R, p.y - spd);
      if (p.keys.down)  p.y = Math.min(ARENA_H - PLAYER_R, p.y + spd);
      if (p.keys.left)  p.x = Math.max(PLAYER_R, p.x - spd);
      if (p.keys.right) p.x = Math.min(ARENA_W - PLAYER_R, p.x + spd);
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 14) p.trail.shift();

      if (!p.invincible) {
        for (const b of room.dangerBalls) {
          const dx = p.x - b.x, dy = p.y - b.y;
          if (Math.sqrt(dx*dx+dy*dy) < PLAYER_R + b.r) {
            p.alive = false;
            p.survivalTime = (Date.now() - room.startTime) / 1000;
            p.xpEarned = Math.floor(p.survivalTime * 2);
            io.to(room.code).emit('player_died', { id: p.id, time: p.survivalTime, xp: p.xpEarned });
            break;
          }
        }
      }
    });

    io.to(room.code).emit('tick', {
      players: Object.values(room.players).map(p => ({
        id: p.id, x: p.x, y: p.y, alive: p.alive,
        color: p.color, trail: p.trail, name: p.name,
        dashing: p.dashing, ulti1cd: p.ulti1cd, ulti2cd: p.ulti2cd,
      })),
      dangerBalls: room.dangerBalls.map(b => ({ id: b.id, x: b.x, y: b.y, r: b.r, color: b.color, frozen: b.frozen })),
      elapsed: (Date.now() - room.startTime) / 1000,
    });

    if (Object.values(room.players).filter(p => p.alive).length === 0 && Object.keys(room.players).length > 0) {
      endRoom(room);
    }
  }, TICK);
}

function endRoom(room) {
  room.started = false;
  clearInterval(room.spawnTimer);
  clearInterval(room.tickTimer);
  const scores = Object.values(room.players)
    .map(p => ({ id: p.id, name: p.name, color: p.color, time: p.survivalTime || 0, xp: p.xpEarned || 0 }))
    .sort((a, b) => b.time - a.time);
  io.to(room.code).emit('game_over', { scores });
}

function generateCode() { return Math.random().toString(36).substring(2, 7).toUpperCase(); }

const COLORS = ['#ff6b6b','#4ecdc4','#45b7d1','#ffd93d','#6bcb77','#c77dff','#ff9f43','#48dbfb'];
let colorIdx = 0;

io.on('connection', (socket) => {
  socket.on('create_room', ({ name, cosmetic }) => {
    const code = generateCode();
    rooms[code] = createRoom(code);
    const color = cosmetic?.color || COLORS[colorIdx++ % COLORS.length];
    rooms[code].players[socket.id] = mkPlayer(socket.id, name, color, cosmetic, ARENA_W/2, ARENA_H/2);
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastLobby(code);
  });

  socket.on('join_room', ({ code, name, cosmetic }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Salle introuvable' });
    if (room.started) return socket.emit('error', { msg: 'Partie en cours' });
    const color = cosmetic?.color || COLORS[colorIdx++ % COLORS.length];
    room.players[socket.id] = mkPlayer(socket.id, name, color, cosmetic,
      100 + Math.random() * (ARENA_W-200), 100 + Math.random() * (ARENA_H-200));
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcastLobby(code);
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (Object.keys(room.players)[0] !== socket.id) return;
    Object.values(room.players).forEach((p, i) => {
      p.alive = true; p.trail = []; p.survivalTime = 0; p.xpEarned = 0;
      p.x = 150 + (i % 4) * 160; p.y = 150 + Math.floor(i/4) * 200;
      p.keys = { up:false, down:false, left:false, right:false };
      p.ulti1cd = 0; p.ulti2cd = 0; p.dashing = false; p.invincible = false;
    });
    room.dangerBalls = [];
    io.to(code).emit('game_starting');
    setTimeout(() => startRoom(room), 1500);
  });

  socket.on('keys', ({ code, keys }) => {
    const p = rooms[code]?.players[socket.id];
    if (p) p.keys = keys;
  });

  socket.on('ulti1', ({ code }) => {
    const p = rooms[code]?.players[socket.id];
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now < p.ulti1cd) return;
    p.ulti1cd = now + 8000;
    p.dashing = true; p.invincible = true;
    setTimeout(() => { if (p) { p.dashing = false; p.invincible = false; } }, 600);
    io.to(code).emit('ulti_used', { id: socket.id, type: 'dash' });
  });

  socket.on('ulti2', ({ code }) => {
    const room = rooms[code];
    const p = room?.players[socket.id];
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now < p.ulti2cd) return;
    p.ulti2cd = now + 15000;
    room.dangerBalls.forEach(b => { b.frozen = true; setTimeout(() => { b.frozen = false; }, 3000); });
    io.to(code).emit('ulti_used', { id: socket.id, type: 'freeze' });
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (!room.players[socket.id]) continue;
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) {
        clearInterval(room.spawnTimer); clearInterval(room.tickTimer); delete rooms[code];
      } else broadcastLobby(code);
    }
  });
});

function mkPlayer(id, name, color, cosmetic, x, y) {
  return { id, name: name||'Joueur', color, x, y,
    keys:{up:false,down:false,left:false,right:false},
    alive:true, trail:[], dashing:false, invincible:false,
    ulti1cd:0, ulti2cd:0, survivalTime:0, xpEarned:0, cosmetic:cosmetic||{} };
}

function broadcastLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('lobby_update', {
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color })),
    hostId: Object.keys(room.players)[0],
  });
}

server.listen(process.env.PORT || 3000, () => console.log('Server on port', process.env.PORT || 3000));
