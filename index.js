import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import path from 'path';
import sharedSession from 'express-socket.io-session';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const __dirname = path.resolve();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'static')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB connection
await mongoose.connect('mongodb+srv://123:123@tictactoeserver.nmbzvmm.mongodb.net/?retryWrites=true&w=majority&appName=tictactoeserver');

const sessionMiddleware = session({
  secret: 'your-secret-key-please-change',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: 'mongodb+srv://123:123@tictactoeserver.nmbzvmm.mongodb.net/?retryWrites=true&w=majority&appName=tictactoeserver' }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
});
app.use(sessionMiddleware);
io.use(sharedSession(sessionMiddleware, { autoSave: true }));

// User schema and model
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  passwordHash: String,
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// Move schema and model
const moveSchema = new mongoose.Schema({
  place: Number,
  type: String,
});
const Move = mongoose.model('Move', moveSchema);

// Chat message schema and model
const chatMessageSchema = new mongoose.Schema({
  user: String,
  msg: String,
  createdAt: { type: Date, default: Date.now }
});
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

// Middleware to check authentication
function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

// Routes
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('login', { error: 'Please provide username and password' });
  }

  const user = await User.findOne({ username });
  if (!user || !user.passwordHash) {
    return res.render('login', { error: 'Invalid username or password' });
  }

  try {
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.render('login', { error: 'Invalid username or password' });
    }
  } catch (err) {
    console.error('bcrypt compare error:', err);
    return res.render('login', { error: 'An error occurred during login' });
  }

  req.session.user = { id: user._id, username: user.username };
  res.redirect('/');
});

app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

app.post('/signup', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('signup', { error: 'Missing username or password' });
  }

  const exists = await User.findOne({ username });
  if (exists) {
    return res.render('signup', { error: 'Username already taken' });
  }

  const hash = await bcrypt.hash(password, 10);
  const newUser = new User({ username, passwordHash: hash });
  await newUser.save();

  req.session.user = { id: newUser._id, username: newUser.username };
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Game page
app.get('/', isAuthenticated, async (req, res) => {
  res.render('index', { username: req.session.user.username });
});

// Game state variables
let players = {};
let playerSlots = { x: null, o: null };
let currentTurn = 'x';
let gameActive = true;

function assignRole(socketId, username) {
  // Not in dev mode: only allow one active player per username
  const usernameAlreadyConnected = Object.values(players).some(
    p => p.username === username
  );
  if (usernameAlreadyConnected) {
    players[socketId] = { symbol: 'spectator', username };
    return 'spectator';
  }

  // Assign X or O if free
  if (!playerSlots.x) {
    playerSlots.x = socketId;
    players[socketId] = { symbol: 'x', username };
    return 'x';
  }
  if (!playerSlots.o) {
    playerSlots.o = socketId;
    players[socketId] = { symbol: 'o', username };
    return 'o';
  }

  // Otherwise, assign spectator
  players[socketId] = { symbol: 'spectator', username };
  return 'spectator';
}

async function broadcastPlayersInfo() {
  const uniquePlayers = {};
  for (const p of Object.values(players)) {
    if (!uniquePlayers[p.username]) {
      uniquePlayers[p.username] = p;
    }
  }
  const usernames = Object.keys(uniquePlayers);
  const users = await User.find({ username: { $in: usernames } });

  for (const username of usernames) {
    const user = users.find(u => u.username === username);
    if (user) {
      uniquePlayers[username].wins = user.wins;
      uniquePlayers[username].losses = user.losses;
    } else {
      uniquePlayers[username].wins = 0;
      uniquePlayers[username].losses = 0;
    }
  }

  // Spectator lineup (in join order)
  const spectatorLineup = Object.values(players)
    .filter(p => p.symbol === 'spectator')
    .map(p => p.username);

  io.emit('playersInfo', Object.values(uniquePlayers));
  io.emit('spectatorLineup', spectatorLineup);
}

function resetGame() {
  gameActive = true;
  currentTurn = 'x';
  Move.deleteMany({}).then(() => {
    io.emit('boardReset');
    io.emit('turnUpdate', currentTurn);
  });
}

function checkWin(moves) {
  const wins = [
    [1,2,3],[4,5,6],[7,8,9],
    [1,4,7],[2,5,8],[3,6,9],
    [1,5,9],[3,5,7]
  ];

  for (const combo of wins) {
    const [a,b,c] = combo;
    const ma = moves.find(m => m.place === a);
    const mb = moves.find(m => m.place === b);
    const mc = moves.find(m => m.place === c);
    if (ma && mb && mc && ma.type === mb.type && mb.type === mc.type) {
      return { winner: ma.type, line: combo };
    }
  }
  return null;
}

const CHAT_HISTORY_LIMIT = 100; // Limit to last 100 messages
const chatHistory = [];

io.on('connection', async (socket) => {
  // Reject unauthorized users if no session
  if (!socket.handshake.session || !socket.handshake.session.user) {
    socket.disconnect();
    return;
  }

  const username = socket.handshake.session.user.username;
  const role = assignRole(socket.id, username);

  socket.emit('assignSymbol', { symbol: role, name: username, stats: { wins: 0, losses: 0 } });

  await broadcastPlayersInfo();

  const moves = await Move.find({});
  socket.emit('boardState', moves);
  io.emit('turnUpdate', currentTurn);

  io.emit('playersUpdate', {
    players: Object.values(players).filter(p => p.symbol === 'x' || p.symbol === 'o').length,
    spectators: Object.values(players).filter(p => p.symbol === 'spectator').length,
  });

  // Send chat history to the newly connected client
  socket.emit('chatHistory', chatHistory);

  socket.on('makeMove', async ({ place, symbol }) => {
    if (!gameActive) {
      socket.emit('errorMsg', 'Game is over, please reset.');
      return;
    }
    if (!players[socket.id] || players[socket.id].symbol !== symbol) {
      socket.emit('errorMsg', 'Not your symbol');
      return;
    }
    if (symbol !== currentTurn) {
      socket.emit('errorMsg', 'Not your turn');
      return;
    }
    const exists = await Move.findOne({ place });
    if (exists) {
      socket.emit('errorMsg', 'Square already taken');
      return;
    }

    const newMove = new Move({ place, type: symbol });
    await newMove.save();

    io.emit('newMove', { place, symbol });

    const allMoves = await Move.find({});
    const win = checkWin(allMoves);

    if (win) {
      gameActive = false;

      const winnerPlayer = Object.entries(players).find(([id, p]) => p.symbol === win.winner);
      const loserPlayer = Object.entries(players).find(([id, p]) => p.symbol !== win.winner && p.symbol !== 'spectator');

      // Update stats
      if (winnerPlayer) {
        await User.findOneAndUpdate({ username: winnerPlayer[1].username }, { $inc: { wins: 1 } });
      }
      if (loserPlayer) {
        await User.findOneAndUpdate({ username: loserPlayer[1].username }, { $inc: { losses: 1 } });
      }

      // Get winner's username BEFORE changing any symbols
      const winnerUsername =
        winnerPlayer && winnerPlayer[1] && winnerPlayer[1].username
          ? winnerPlayer[1].username
          : null;

      // --- Symbol swap and spectator promotion ---
      // Find all spectators in join order
      const spectatorEntries = Object.entries(players).filter(([id, p]) => p.symbol === 'spectator');
      if (winnerPlayer && loserPlayer) {
        const [winnerId, winnerObj] = winnerPlayer;
        const [loserId, loserObj] = loserPlayer;

        // If there is at least one spectator, promote first spectator to replace loser
        if (spectatorEntries.length > 0) {
          const [specId, specObj] = spectatorEntries[0];
          // Assign loser as spectator
          players[loserId].symbol = 'spectator';
          // Promote spectator to loser's symbol
          players[specId].symbol = loserObj.symbol;
          // Update playerSlots
          if (loserObj.symbol === 'x') playerSlots.x = specId;
          if (loserObj.symbol === 'o') playerSlots.o = specId;
          // Remove spectator from lineup
          // (already handled by symbol change)
        } else {
          // No spectators: just swap X and O
          const temp = winnerObj.symbol;
          players[winnerId].symbol = loserObj.symbol;
          players[loserId].symbol = temp;
          // Update playerSlots
          if (players[winnerId].symbol === 'x') playerSlots.x = winnerId;
          if (players[winnerId].symbol === 'o') playerSlots.o = winnerId;
          if (players[loserId].symbol === 'x') playerSlots.x = loserId;
          if (players[loserId].symbol === 'o') playerSlots.o = loserId;
        }
      }

      await broadcastPlayersInfo();

      io.emit('winDetected', { winner: win.winner, line: win.line, winnerUsername });
    } else {
      if (allMoves.length >= 9) {
        gameActive = false;
        io.emit('winDetected', { winner: 'draw', line: null });
      } else {
        currentTurn = currentTurn === 'x' ? 'o' : 'x';
        io.emit('turnUpdate', currentTurn);
      }
    }
  });

  socket.on('resetBoard', async () => {
    if (!players[socket.id] || players[socket.id].symbol === 'spectator') {
      socket.emit('errorMsg', 'Only players can reset the board');
      return;
    }
    resetGame();
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (!player) return;

    if (player.symbol === 'x' || player.symbol === 'o') {
      if (playerSlots.x === socket.id) playerSlots.x = null;
      if (playerSlots.o === socket.id) playerSlots.o = null;
      delete players[socket.id];

      // Promote a spectator to player if possible
      const spectatorEntry = Object.entries(players).find(([id, p]) => p.symbol === 'spectator');
      if (spectatorEntry) {
        const [specId] = spectatorEntry;
        if (!playerSlots.x) {
          playerSlots.x = specId;
          players[specId].symbol = 'x';
          io.to(specId).emit('assignSymbol', { symbol: 'x', name: players[specId].username, stats: { wins: players[specId].wins, losses: players[specId].losses } });
        } else if (!playerSlots.o) {
          playerSlots.o = specId;
          players[specId].symbol = 'o';
          io.to(specId).emit('assignSymbol', { symbol: 'o', name: players[specId].username, stats: { wins: players[specId].wins, losses: players[specId].losses } });
        }
      }
    } else {
      delete players[socket.id];
    }

    broadcastPlayersInfo();

    io.emit('playersUpdate', {
      players: Object.values(players).filter(p => p.symbol === 'x' || p.symbol === 'o').length,
      spectators: Object.values(players).filter(p => p.symbol === 'spectator').length,
    });
  });

  socket.on('chatMsg', async (msg) => {
    const username = socket.handshake.session.user.username;
    if (typeof msg === 'string' && msg.trim().length > 0 && msg.length <= 200) {
      const chatMsg = { user: username, msg: msg.trim().slice(0, 200) };
      // Save to MongoDB
      await ChatMessage.create(chatMsg);
      // Broadcast to all clients
      io.emit('chatMsg', chatMsg);
    }
  });

  socket.on('clearChat', async () => {
    await ChatMessage.deleteMany({});
    io.emit('chatHistory', []);
  });
});

server.listen(3000, '10.0.0.208', () => {
  console.log('Server started on http://10.0.0.208:3000');
});
