const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const MAP_W = 2400;
const MAP_H = 2400;
const TICK = 50; // ms
const SPEED = 4;
const PLAYER_SIZE = 20;
const RESOURCE_SIZE = 16;
const ATTACK_RANGE = 50;
const ATTACK_DMG = 10;
const ATTACK_CD = 800; // ms

const players = {};
const resources = [];

// Generate resources
function genResources() {
  const types = ['wood', 'stone', 'gold'];
  const counts = { wood: 40, stone: 25, gold: 15 };
  let id = 0;
  for (const type of types) {
    for (let i = 0; i < counts[type]; i++) {
      resources.push({
        id: id++,
        type,
        x: 100 + Math.random() * (MAP_W - 200),
        y: 100 + Math.random() * (MAP_H - 200),
        alive: true,
        respawnAt: null,
      });
    }
  }
}

genResources();

// Respawn resources
setInterval(() => {
  const now = Date.now();
  resources.forEach(r => {
    if (!r.alive && r.respawnAt && now >= r.respawnAt) {
      r.alive = true;
      r.x = 100 + Math.random() * (MAP_W - 200);
      r.y = 100 + Math.random() * (MAP_H - 200);
      io.emit('resource_update', { id: r.id, alive: true, x: r.x, y: r.y });
    }
  });
}, 1000);

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Game tick
setInterval(() => {
  for (const id in players) {
    const p = players[id];
    let moved = false;

    if (p.keys.up)    { p.y = Math.max(PLAYER_SIZE, p.y - SPEED); moved = true; }
    if (p.keys.down)  { p.y = Math.min(MAP_H - PLAYER_SIZE, p.y + SPEED); moved = true; }
    if (p.keys.left)  { p.x = Math.max(PLAYER_SIZE, p.x - SPEED); moved = true; }
    if (p.keys.right) { p.x = Math.min(MAP_W - PLAYER_SIZE, p.x + SPEED); moved = true; }
  }

  // Broadcast state
  const state = Object.values(players).map(p => ({
    id: p.id, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp,
    inv: p.inventory, color: p.color, name: p.name, attacking: p.attacking
  }));

  io.emit('game_state', state);
}, TICK);

const COLORS = ['#e8ff47','#ff4757','#2ed573','#1e90ff','#ff6b81','#eccc68','#a29bfe','#fd79a8'];
let colorIdx = 0;

io.on('connection', (socket) => {
  const color = COLORS[colorIdx % COLORS.length];
  colorIdx++;

  players[socket.id] = {
    id: socket.id,
    x: 200 + Math.random() * (MAP_W - 400),
    y: 200 + Math.random() * (MAP_H - 400),
    hp: 100, maxHp: 100,
    inventory: { wood: 0, stone: 0, gold: 0 },
    color,
    name: 'Player ' + socket.id.slice(0, 4),
    keys: { up: false, down: false, left: false, right: false },
    attacking: false,
    lastAttack: 0,
  };

  // Send initial data
  socket.emit('init', {
    id: socket.id,
    map: { w: MAP_W, h: MAP_H },
    resources: resources.map(r => ({ id: r.id, type: r.type, x: r.x, y: r.y, alive: r.alive })),
  });

  socket.on('keys', (keys) => {
    if (players[socket.id]) players[socket.id].keys = keys;
  });

  socket.on('attack', () => {
    const p = players[socket.id];
    if (!p) return;
    const now = Date.now();
    if (now - p.lastAttack < ATTACK_CD) return;
    p.lastAttack = now;
    p.attacking = true;
    setTimeout(() => { if (players[socket.id]) players[socket.id].attacking = false; }, 200);

    // Hit nearby players
    for (const otherId in players) {
      if (otherId === socket.id) continue;
      const other = players[otherId];
      if (dist(p, other) < ATTACK_RANGE) {
        other.hp = Math.max(0, other.hp - ATTACK_DMG);
        io.to(otherId).emit('hit', { from: socket.id, hp: other.hp });
        if (other.hp <= 0) {
          // Respawn
          other.hp = other.maxHp;
          other.x = 200 + Math.random() * (MAP_W - 400);
          other.y = 200 + Math.random() * (MAP_H - 400);
          other.inventory = { wood: 0, stone: 0, gold: 0 };
          io.to(otherId).emit('died', { killedBy: socket.id });
        }
      }
    }

    // Harvest nearby resources
    resources.forEach(r => {
      if (!r.alive) return;
      if (dist(p, r) < ATTACK_RANGE + RESOURCE_SIZE) {
        r.alive = false;
        r.respawnAt = Date.now() + 8000;
        p.inventory[r.type]++;
        socket.emit('harvested', { type: r.type, inv: p.inventory });
        io.emit('resource_update', { id: r.id, alive: false });
      }
    });
  });

  socket.on('set_name', (name) => {
    if (players[socket.id]) players[socket.id].name = name.slice(0, 12);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});
