const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

const lobbies = {};

const questions = {
  soft: [
    "Sur 10, t'es à quel point flemmard dans la vie ?",
    "Sur 10, t'es à quel point accro à ton téléphone ?",
    "Sur 10, t'es à quel point mauvais menteur ?",
    "Sur 10, t'as pas encore fait ta lessive depuis combien de temps ? (1 = hier, 10 = un mois)",
    "Sur 10, t'es à quel point jaloux/se en couple ?",
    "Sur 10, t'es à quel point fan de toi-même ?",
    "Sur 10, t'oublies souvent les anniversaires des gens ?",
    "Sur 10, t'es à quel point mauvais cuisinier ?",
    "Sur 10, t'es à quel point accro aux réseaux sociaux ?",
    "Sur 10, t'as peur du noir ?",
  ],
  medium: [
    "Sur 10, t'as déjà menti à tes parents pour couvrir quelque chose ?",
    "Sur 10, t'as déjà volé quelque chose (même petit) ?",
    "Sur 10, t'as déjà stalk quelqu'un sur les réseaux ?",
    "Sur 10, t'as déjà fait semblant d'être malade pour sécher ?",
    "Sur 10, t'as déjà lu les messages de quelqu'un sans permission ?",
    "Sur 10, t'as déjà trahi un secret d'un ami ?",
    "Sur 10, t'as déjà ghosté quelqu'un sans raison valable ?",
    "Sur 10, t'as déjà menti sur ton âge ou ta situation ?",
    "Sur 10, t'as déjà piqué de la thune à tes parents ?",
    "Sur 10, t'as déjà fait un truc honteux sous l'alcool ?",
  ],
  hard: [
    "Sur 10, t'as déjà eu des pensées que tu n'oserais jamais dire à voix haute ?",
    "Sur 10, t'as déjà trompé quelqu'un ou t'as été tenté(e) ?",
    "Sur 10, t'as déjà aimé quelqu'un qui était pris(e) ?",
    "Sur 10, t'as déjà fait un truc dont tu as encore honte aujourd'hui ?",
    "Sur 10, t'as déjà eu envie de tout plaquer et disparaître ?",
    "Sur 10, t'as déjà menti à ton meilleur ami pour te protéger toi ?",
    "Sur 10, t'as déjà fantasmé sur quelqu'un de ton entourage proche ?",
    "Sur 10, t'as déjà fait semblant d'aimer quelqu'un pour ce qu'il/elle pouvait t'apporter ?",
    "Sur 10, t'as des secrets que tu emporteras dans ta tombe ?",
    "Sur 10, t'as déjà eu des pensées que tu jugerais chez les autres ?",
  ]
};

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function getRandomQuestion(difficulty) {
  const list = questions[difficulty];
  return list[Math.floor(Math.random() * list.length)];
}

io.on('connection', (socket) => {

  // Créer un lobby
  socket.on('create_lobby', ({ difficulty }) => {
    const code = generateCode();
    lobbies[code] = {
      code,
      difficulty,
      host: socket.id,
      players: [socket.id],
      state: 'waiting', // waiting, question, results
      currentQuestion: null,
      answers: {},
      questionCount: 0,
    };
    socket.join(code);
    socket.emit('lobby_created', { code, difficulty });
    io.to(code).emit('lobby_update', { playerCount: lobbies[code].players.length });
  });

  // Rejoindre un lobby
  socket.on('join_lobby', ({ code }) => {
    const lobby = lobbies[code];
    if (!lobby) return socket.emit('error', { message: "Lobby introuvable !" });
    if (lobby.state !== 'waiting') return socket.emit('error', { message: "La partie a déjà commencé !" });

    lobby.players.push(socket.id);
    socket.join(code);
    socket.emit('lobby_joined', { code, difficulty: lobby.difficulty });
    io.to(code).emit('lobby_update', { playerCount: lobby.players.length });
  });

  // Lancer la partie (host seulement)
  socket.on('start_game', ({ code }) => {
    const lobby = lobbies[code];
    if (!lobby || lobby.host !== socket.id) return;
    if (lobby.players.length < 2) return socket.emit('error', { message: "Il faut au moins 2 joueurs !" });

    nextQuestion(code);
  });

  // Envoyer une réponse
  socket.on('send_answer', ({ code, answer }) => {
    const lobby = lobbies[code];
    if (!lobby || lobby.state !== 'question') return;

    lobby.answers[socket.id] = answer;

    // Si tout le monde a répondu
    if (Object.keys(lobby.answers).length === lobby.players.length) {
      showResults(code);
    }
  });

  // Question suivante
  socket.on('next_question', ({ code }) => {
    const lobby = lobbies[code];
    if (!lobby || lobby.host !== socket.id) return;
    nextQuestion(code);
  });

  socket.on('disconnect', () => {
    for (const code in lobbies) {
      const lobby = lobbies[code];
      lobby.players = lobby.players.filter(id => id !== socket.id);
      if (lobby.players.length === 0) {
        delete lobbies[code];
      } else {
        if (lobby.host === socket.id) {
          lobby.host = lobby.players[0];
          io.to(code).emit('new_host', { hostId: lobby.host });
        }
        io.to(code).emit('lobby_update', { playerCount: lobby.players.length });
      }
    }
  });
});

function nextQuestion(code) {
  const lobby = lobbies[code];
  lobby.state = 'question';
  lobby.answers = {};
  lobby.questionCount++;
  lobby.currentQuestion = getRandomQuestion(lobby.difficulty);

  io.to(code).emit('new_question', {
    question: lobby.currentQuestion,
    questionNumber: lobby.questionCount,
  });
}

function showResults(code) {
  const lobby = lobbies[code];
  lobby.state = 'results';

  // Compter les votes par valeur (anonyme)
  const counts = {};
  for (let i = 1; i <= 10; i++) counts[i] = 0;
  for (const playerId in lobby.answers) {
    const val = lobby.answers[playerId];
    counts[val] = (counts[val] || 0) + 1;
  }

  io.to(code).emit('show_results', {
    counts,
    total: lobby.players.length,
    question: lobby.currentQuestion,
    isHost: undefined, // handled client side
  });
}

server.listen(process.env.PORT || 3000, () => {
  console.log('Serveur démarré sur le port', process.env.PORT || 3000);
});
