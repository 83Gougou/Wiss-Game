const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

const COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];
const SPECIAL_EFFECTS = [
  'skip', 'reverse', 'draw2', 'draw4', 'steal', 'mirror',
  'chaos', 'spy', 'bomb', 'swap_hands', 'vote', 'shield'
];

const EFFECT_LABELS = {
  skip: '⏭️ Skip',
  reverse: '🔄 Inversion',
  draw2: '+2 Pioche',
  draw4: '+4 Pioche',
  steal: '🦊 Vol',
  mirror: '🪞 Miroir',
  chaos: '🎰 Chaos',
  spy: '👁️ Espion',
  bomb: '💣 Bombe',
  swap_hands: '🔀 Échange',
  vote: '🗳️ Vote',
  shield: '🛡️ Bouclier',
};

const lobbies = {};

function createDeck() {
  const deck = [];
  let id = 0;
  // Normal cards
  COLORS.forEach(color => {
    for (let val = 1; val <= 9; val++) {
      deck.push({ id: id++, color, value: val, type: 'number' });
      deck.push({ id: id++, color, value: val, type: 'number' });
    }
    deck.push({ id: id++, color, value: 0, type: 'number' });
    // Special per color
    ['skip', 'reverse', 'draw2'].forEach(effect => {
      deck.push({ id: id++, color, value: null, type: 'special', effect });
      deck.push({ id: id++, color, value: null, type: 'special', effect });
    });
  });
  // Wild cards
  ['draw4', 'steal', 'mirror', 'chaos', 'spy', 'bomb', 'swap_hands', 'vote', 'shield'].forEach(effect => {
    for (let i = 0; i < 3; i++) {
      deck.push({ id: id++, color: 'wild', value: null, type: 'wild', effect });
    }
  });
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function getLobby(code) { return lobbies[code]; }

function broadcastLobby(code) {
  const lobby = getLobby(code);
  if (!lobby) return;
  lobby.players.forEach(p => {
    io.to(p.id).emit('lobby_state', {
      code,
      players: lobby.players.map(pl => ({
        id: pl.id, name: pl.name, color: pl.color,
        cardCount: pl.hand.length, score: pl.score,
        isHost: pl.id === lobby.host,
        shielded: pl.shielded,
      })),
      isHost: p.id === lobby.host,
      gameStarted: lobby.gameStarted,
    });
  });
}

function broadcastGame(code) {
  const lobby = getLobby(code);
  if (!lobby) return;
  lobby.players.forEach(p => {
    io.to(p.id).emit('game_state', {
      hand: p.hand,
      topCard: lobby.discard[lobby.discard.length - 1],
      currentPlayer: lobby.players[lobby.turnIndex]?.id,
      direction: lobby.direction,
      players: lobby.players.map(pl => ({
        id: pl.id, name: pl.name, color: pl.color,
        cardCount: pl.hand.length, score: pl.score,
        shielded: pl.shielded,
        isCurrentTurn: lobby.players[lobby.turnIndex]?.id === pl.id,
      })),
      deckCount: lobby.deck.length,
      pendingEffect: lobby.pendingEffect,
      voteOptions: lobby.voteOptions || null,
      votes: lobby.votes || null,
      log: lobby.log.slice(-6),
      bombActive: lobby.bombActive,
      bombTarget: lobby.bombTarget,
    });
  });
}

function dealCards(lobby) {
  lobby.players.forEach(p => {
    p.hand = lobby.deck.splice(0, 7);
  });
}

function drawCard(lobby, count = 1) {
  const cards = [];
  for (let i = 0; i < count; i++) {
    if (lobby.deck.length === 0) {
      const top = lobby.discard.pop();
      lobby.deck = shuffle(lobby.discard);
      lobby.discard = [top];
    }
    if (lobby.deck.length > 0) cards.push(lobby.deck.shift());
  }
  return cards;
}

function nextTurn(lobby, skip = false) {
  const step = skip ? 2 : 1;
  lobby.turnIndex = (lobby.turnIndex + lobby.direction * step + lobby.players.length) % lobby.players.length;
  lobby.pendingEffect = null;
  clearBomb(lobby);
}

function addLog(lobby, msg) {
  lobby.log.push(msg);
  if (lobby.log.length > 20) lobby.log.shift();
}

function clearBomb(lobby) {
  if (lobby.bombTimer) { clearTimeout(lobby.bombTimer); lobby.bombTimer = null; }
  lobby.bombActive = false;
  lobby.bombTarget = null;
}

function canPlay(card, topCard, chosenColor) {
  if (!topCard) return true;
  if (card.type === 'wild') return true;
  const tc = chosenColor || topCard.color;
  if (card.color === tc) return true;
  if (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) return true;
  if (card.type === 'special' && topCard.type === 'special' && card.effect === topCard.effect) return true;
  return false;
}

function checkWin(lobby, player) {
  if (player.hand.length === 0) {
    // Score: others' cards count
    const points = lobby.players.reduce((sum, p) => {
      return sum + p.hand.reduce((s, c) => s + (c.type === 'number' ? c.value : 20), 0);
    }, 0);
    player.score += points;
    addLog(lobby, `🏆 ${player.name} gagne la manche ! +${points} pts`);
    io.to(lobby.code).emit('round_over', {
      winner: player.name,
      scores: lobby.players.map(p => ({ name: p.name, score: p.score, color: p.color })),
    });
    return true;
  }
  return false;
}

const PLAYER_COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];

io.on('connection', (socket) => {

  socket.on('create_lobby', ({ name }) => {
    const code = generateCode();
    const color = PLAYER_COLORS[0];
    lobbies[code] = {
      code, host: socket.id,
      players: [{ id: socket.id, name: name || 'Host', hand: [], score: 0, color, shielded: false }],
      deck: [], discard: [], turnIndex: 0, direction: 1,
      gameStarted: false, pendingEffect: null, chosenColor: null,
      log: [], bombActive: false, bombTarget: null, bombTimer: null,
      voteOptions: null, votes: null,
    };
    socket.join(code);
    socket.emit('joined', { code });
    broadcastLobby(code);
  });

  socket.on('join_lobby', ({ code, name }) => {
    const lobby = getLobby(code);
    if (!lobby) return socket.emit('error', { msg: 'Lobby introuvable' });
    if (lobby.gameStarted) return socket.emit('error', { msg: 'Partie déjà en cours' });
    if (lobby.players.length >= 8) return socket.emit('error', { msg: 'Lobby plein' });
    const color = PLAYER_COLORS[lobby.players.length % PLAYER_COLORS.length];
    lobby.players.push({ id: socket.id, name: name || 'Joueur', hand: [], score: 0, color, shielded: false });
    socket.join(code);
    socket.emit('joined', { code });
    broadcastLobby(code);
  });

  socket.on('start_game', ({ code }) => {
    const lobby = getLobby(code);
    if (!lobby || lobby.host !== socket.id) return;
    if (lobby.players.length < 2) return socket.emit('error', { msg: 'Il faut au moins 2 joueurs' });
    lobby.deck = createDeck();
    lobby.gameStarted = true;
    lobby.turnIndex = 0;
    lobby.direction = 1;
    dealCards(lobby);
    // First card
    let first = lobby.deck.shift();
    while (first.type === 'wild') { lobby.deck.push(first); first = lobby.deck.shift(); }
    lobby.discard = [first];
    addLog(lobby, '🎮 La partie commence !');
    broadcastGame(code);
  });

  socket.on('play_card', ({ code, cardId, chosenColor }) => {
    const lobby = getLobby(code);
    if (!lobby || !lobby.gameStarted) return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (currentPlayer.id !== socket.id) return;

    const cardIdx = currentPlayer.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;
    const card = currentPlayer.hand[cardIdx];
    const topCard = lobby.discard[lobby.discard.length - 1];

    if (!canPlay(card, topCard, lobby.chosenColor)) {
      return socket.emit('error', { msg: "Tu ne peux pas jouer cette carte !" });
    }

    currentPlayer.hand.splice(cardIdx, 1);
    if (card.type === 'wild') card.chosenColor = chosenColor || 'red';
    lobby.discard.push(card);
    lobby.chosenColor = card.type === 'wild' ? (chosenColor || 'red') : null;
    addLog(lobby, `${currentPlayer.name} joue ${card.type === 'number' ? card.value : (EFFECT_LABELS[card.effect] || card.effect)}`);

    if (checkWin(lobby, currentPlayer)) return;

    // Apply effects
    applyEffect(lobby, card, currentPlayer);
    broadcastGame(code);
  });

  socket.on('draw_card', ({ code }) => {
    const lobby = getLobby(code);
    if (!lobby || !lobby.gameStarted) return;
    const currentPlayer = lobby.players[lobby.turnIndex];
    if (currentPlayer.id !== socket.id) return;

    const drawn = drawCard(lobby, 1);
    currentPlayer.hand.push(...drawn);
    addLog(lobby, `${currentPlayer.name} pioche une carte`);
    nextTurn(lobby);
    broadcastGame(code);
  });

  socket.on('vote_choice', ({ code, choice }) => {
    const lobby = getLobby(code);
    if (!lobby || !lobby.votes) return;
    if (!lobby.votes[socket.id]) {
      lobby.votes[socket.id] = choice;
      const totalVotes = Object.keys(lobby.votes).length;
      if (totalVotes >= lobby.players.length) {
        // Tally
        const tally = {};
        Object.values(lobby.votes).forEach(v => { tally[v] = (tally[v] || 0) + 1; });
        const winner = Object.entries(tally).sort((a,b) => b[1]-a[1])[0][0];
        addLog(lobby, `🗳️ Vote: "${winner}" gagne !`);
        applyVoteResult(lobby, winner);
        lobby.voteOptions = null;
        lobby.votes = null;
        broadcastGame(code);
      } else {
        broadcastGame(code);
      }
    }
  });

  socket.on('chat', ({ code, msg }) => {
    const lobby = getLobby(code);
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;
    io.to(code).emit('chat_msg', { name: player.name, color: player.color, msg: msg.slice(0, 100) });
  });

  socket.on('new_round', ({ code }) => {
    const lobby = getLobby(code);
    if (!lobby || lobby.host !== socket.id) return;
    lobby.deck = createDeck();
    lobby.discard = [];
    lobby.pendingEffect = null;
    lobby.chosenColor = null;
    lobby.voteOptions = null;
    lobby.votes = null;
    clearBomb(lobby);
    dealCards(lobby);
    let first = lobby.deck.shift();
    while (first.type === 'wild') { lobby.deck.push(first); first = lobby.deck.shift(); }
    lobby.discard = [first];
    addLog(lobby, '🔄 Nouvelle manche !');
    broadcastGame(code);
  });

  socket.on('disconnect', () => {
    for (const code in lobbies) {
      const lobby = lobbies[code];
      const idx = lobby.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;
      const name = lobby.players[idx].name;
      lobby.players.splice(idx, 1);
      if (lobby.players.length === 0) { delete lobbies[code]; continue; }
      if (lobby.host === socket.id) lobby.host = lobby.players[0].id;
      if (lobby.gameStarted) {
        lobby.turnIndex = lobby.turnIndex % lobby.players.length;
        addLog(lobby, `${name} a quitté la partie`);
        broadcastGame(code);
      } else {
        broadcastLobby(code);
      }
    }
  });
});

function applyEffect(lobby, card, player) {
  const code = lobby.code;
  if (card.type === 'number') { nextTurn(lobby); return; }

  const effect = card.effect;

  if (effect === 'skip') {
    addLog(lobby, '⏭️ Tour sauté !');
    nextTurn(lobby, true);
  } else if (effect === 'reverse') {
    lobby.direction *= -1;
    addLog(lobby, '🔄 Direction inversée !');
    nextTurn(lobby);
  } else if (effect === 'draw2') {
    const next = lobby.players[(lobby.turnIndex + lobby.direction + lobby.players.length) % lobby.players.length];
    if (!next.shielded) {
      next.hand.push(...drawCard(lobby, 2));
      addLog(lobby, `${next.name} pioche 2 cartes !`);
    } else {
      next.shielded = false;
      addLog(lobby, `🛡️ ${next.name} bloque avec son bouclier !`);
    }
    nextTurn(lobby, true);
  } else if (effect === 'draw4') {
    const next = lobby.players[(lobby.turnIndex + lobby.direction + lobby.players.length) % lobby.players.length];
    if (!next.shielded) {
      next.hand.push(...drawCard(lobby, 4));
      addLog(lobby, `${next.name} pioche 4 cartes !`);
    } else {
      next.shielded = false;
      addLog(lobby, `🛡️ ${next.name} bloque !`);
    }
    nextTurn(lobby, true);
  } else if (effect === 'steal') {
    // Steal random card from next player
    const next = lobby.players[(lobby.turnIndex + lobby.direction + lobby.players.length) % lobby.players.length];
    if (next.hand.length > 0 && !next.shielded) {
      const stolen = next.hand.splice(Math.floor(Math.random() * next.hand.length), 1)[0];
      player.hand.push(stolen);
      addLog(lobby, `🦊 ${player.name} vole une carte à ${next.name} !`);
    }
    nextTurn(lobby);
  } else if (effect === 'mirror') {
    // Previous player gets the effect of the card before
    addLog(lobby, '🪞 Effet miroir ! Le joueur précédent prend l\'effet !');
    const prev = lobby.players[(lobby.turnIndex - lobby.direction + lobby.players.length) % lobby.players.length];
    prev.hand.push(...drawCard(lobby, 2));
    nextTurn(lobby);
  } else if (effect === 'chaos') {
    // Random effect
    const effects = ['draw2_all', 'shuffle_hands', 'reverse_hands', 'skip_all', 'everyone_draws1'];
    const chosen = effects[Math.floor(Math.random() * effects.length)];
    if (chosen === 'draw2_all') {
      lobby.players.forEach(p => { if (p.id !== player.id) p.hand.push(...drawCard(lobby, 2)); });
      addLog(lobby, '🎰 CHAOS: Tout le monde pioche 2 !');
    } else if (chosen === 'shuffle_hands') {
      const allCards = lobby.players.flatMap(p => p.hand);
      const shuffled = shuffle(allCards);
      let i = 0;
      lobby.players.forEach(p => { p.hand = shuffled.splice(0, Math.ceil(allCards.length / lobby.players.length)); });
      addLog(lobby, '🎰 CHAOS: Les mains sont redistribuées !');
    } else if (chosen === 'everyone_draws1') {
      lobby.players.forEach(p => p.hand.push(...drawCard(lobby, 1)));
      addLog(lobby, '🎰 CHAOS: Tout le monde pioche 1 !');
    } else if (chosen === 'skip_all') {
      addLog(lobby, '🎰 CHAOS: Tour sauté pour tous !');
    }
    nextTurn(lobby);
  } else if (effect === 'spy') {
    // Current player sees everyone's hands — handled client side via special emit
    addLog(lobby, `👁️ ${player.name} espionne les mains !`);
    io.to(player.id).emit('spy_reveal', {
      hands: lobby.players.filter(p => p.id !== player.id).map(p => ({
        name: p.name, color: p.color, hand: p.hand
      }))
    });
    nextTurn(lobby);
  } else if (effect === 'bomb') {
    // Next player has 10 seconds to play or draws 5
    const next = lobby.players[(lobby.turnIndex + lobby.direction + lobby.players.length) % lobby.players.length];
    lobby.bombActive = true;
    lobby.bombTarget = next.id;
    addLog(lobby, `💣 BOMBE sur ${next.name} ! 10 secondes pour jouer !`);
    nextTurn(lobby);
    lobby.bombTimer = setTimeout(() => {
      if (lobby.bombActive && lobby.bombTarget === next.id) {
        next.hand.push(...drawCard(lobby, 5));
        addLog(lobby, `💥 ${next.name} explose ! +5 cartes !`);
        lobby.bombActive = false;
        lobby.bombTarget = null;
        broadcastGame(code);
      }
    }, 10000);
  } else if (effect === 'swap_hands') {
    // Swap hands with player of your choice — just swap with next for simplicity
    const others = lobby.players.filter(p => p.id !== player.id);
    const target = others[Math.floor(Math.random() * others.length)];
    const tmp = player.hand;
    player.hand = target.hand;
    target.hand = tmp;
    addLog(lobby, `🔀 ${player.name} échange sa main avec ${target.name} !`);
    nextTurn(lobby);
  } else if (effect === 'vote') {
    // Everyone votes on a rule
    const options = [
      'Tout le monde pioche 1',
      'Inverser les mains dans le sens du jeu',
      'Le joueur avec le plus de cartes pioche 2',
      'Le prochain joueur saute son tour'
    ];
    lobby.voteOptions = options;
    lobby.votes = {};
    addLog(lobby, '🗳️ Vote collectif ! Choisissez une règle !');
    // Don't advance turn yet — wait for votes
  } else if (effect === 'shield') {
    player.shielded = true;
    addLog(lobby, `🛡️ ${player.name} active son bouclier !`);
    nextTurn(lobby);
  } else {
    nextTurn(lobby);
  }
}

function applyVoteResult(lobby, winner) {
  if (winner === 'Tout le monde pioche 1') {
    lobby.players.forEach(p => p.hand.push(...drawCard(lobby, 1)));
  } else if (winner === 'Le joueur avec le plus de cartes pioche 2') {
    const maxPlayer = lobby.players.reduce((a, b) => a.hand.length > b.hand.length ? a : b);
    maxPlayer.hand.push(...drawCard(lobby, 2));
  } else if (winner === 'Le prochain joueur saute son tour') {
    nextTurn(lobby, true);
    return;
  }
  nextTurn(lobby);
}

server.listen(process.env.PORT || 3000, () => console.log('Server on', process.env.PORT || 3000));
