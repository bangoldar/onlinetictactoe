const socket = io();

let assignedSymbol = null;
let currentTurn = null;
let gameActive = true;

const squares = document.getElementsByClassName('square');
const roleIndicator = document.getElementById('roleIndicator');
const turnInfo = document.getElementById('turnInfo');
const playersStats = document.getElementById('playersStats');
const winMessage = document.getElementById('winMessage');
const resetBtn = document.getElementById('resetBtn');

function clearBoard() {
  for (let sq of squares) {
    sq.innerHTML = '';
    removeWinLine();
  }
}

function createImage(symbol) {
  const img = document.createElement('img');
  if (symbol === 'x') {
    img.src = 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Red_X.svg/1024px-Red_X.svg.png';
    img.alt = 'X';
  } else if (symbol === 'o') {
    img.src = 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/72/OOjs_UI_icon_edit-ltr-progressive.svg/1024px-OOjs_UI_icon_edit-ltr-progressive.svg.png';
    img.alt = 'O';
  }
  return img;
}

function displayWinLine(line) {
  removeWinLine();

  if (!line) return;

  const [a, , c] = line;
  const sqA = squares[a - 1];
  const sqC = squares[c - 1];

  const rectA = sqA.getBoundingClientRect();
  const rectC = sqC.getBoundingClientRect();
  const boardRect = sqA.parentElement.getBoundingClientRect();

  // Calculate center points relative to board
  const x1 = rectA.left + rectA.width / 2 - boardRect.left;
  const y1 = rectA.top + rectA.height / 2 - boardRect.top;
  const x2 = rectC.left + rectC.width / 2 - boardRect.left;
  const y2 = rectC.top + rectC.height / 2 - boardRect.top;

  // Make the line longer by 40px on each side
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  const extra = 40; // pixels to extend on each side
  const x1_ext = x1 - Math.cos(angle) * extra;
  const y1_ext = y1 - Math.sin(angle) * extra;
  const x2_ext = x2 + Math.cos(angle) * extra;
  const y2_ext = y2 + Math.sin(angle) * extra;
  const fullLength = Math.hypot(x2_ext - x1_ext, y2_ext - y1_ext);

  const lineEl = document.createElement('div');
  lineEl.classList.add('win-line');
  lineEl.style.width = '0px'; // Start at 0 for animation
  lineEl.style.height = '10px';
  lineEl.style.position = 'absolute';
  lineEl.style.top = y1_ext + 'px';
  lineEl.style.left = x1_ext + 'px';
  lineEl.style.transformOrigin = '0 50%';
  lineEl.style.transform = `rotate(${angle * 180 / Math.PI}deg)`;
  lineEl.style.background = 'linear-gradient(90deg, #00ffc8, #00eaff 60%, #fff 100%)';
  lineEl.style.boxShadow = '0 0 24px 8px #00ffc8, 0 0 60px 0 #fff';
  lineEl.style.borderRadius = '6px';
  lineEl.style.zIndex = '1000';
  lineEl.style.transition = 'width 0.7s cubic-bezier(.68,-0.55,.27,1.55), box-shadow 0.7s';

  sqA.parentElement.style.position = 'relative';
  sqA.parentElement.appendChild(lineEl);

  // Animate the line
  setTimeout(() => {
    lineEl.style.width = fullLength + 'px';
    lineEl.style.boxShadow = '0 0 40px 16px #00ffc8, 0 0 80px 0 #fff';
  }, 50);
}

function removeWinLine() {
  const existingLine = document.querySelector('.win-line');
  if (existingLine) existingLine.remove();
}

function updateRoleText(symbol) {
  if (symbol === 'spectator') {
    roleIndicator.textContent = 'You are a Spectator';
  } else {
    roleIndicator.textContent = `You are Player '${symbol.toUpperCase()}'`;
  }
}

function updateTurnText(turn) {
  if (!gameActive) {
    turnInfo.textContent = 'Game Over';
  } else {
    turnInfo.textContent = (turn === assignedSymbol)
      ? "It's your turn"
      : `Waiting for player '${turn.toUpperCase()}'`;
  }
}

function updatePlayersStats(players) {
  if (!players || players.length === 0) {
    playersStats.textContent = 'No players connected';
    return;
  }
  let text = 'Players stats:<br>';
  players.forEach(p => {
    const symbol = p.symbol === 'spectator' ? 'Spectator' : p.symbol.toUpperCase();
    text += `${p.username} (${symbol}) - Wins: ${p.wins || 0}, Losses: ${p.losses || 0}<br>`;
  });
  playersStats.innerHTML = text;
}

Array.from(squares).forEach(sq => {
  sq.addEventListener('click', () => {
    if (!gameActive) return;
    if (!assignedSymbol || assignedSymbol === 'spectator') return;

    const place = parseInt(sq.dataset.place);
    if (!place) return;

    socket.emit('makeMove', { place, symbol: assignedSymbol });
  });
});

resetBtn.addEventListener('click', () => {
  socket.emit('resetBoard');
});

// Socket events

socket.on('assignSymbol', ({ symbol, name, stats }) => {
  assignedSymbol = symbol;
  updateRoleText(symbol);
  winMessage.textContent = '';
});

socket.on('boardState', (moves) => {
  clearBoard();
  moves.forEach(move => {
    const sq = document.querySelector(`.square[data-place="${move.place}"]`);
    if (sq) {
      sq.appendChild(createImage(move.type));
    }
  });
});

socket.on('newMove', ({ place, symbol }) => {
  const sq = document.querySelector(`.square[data-place="${place}"]`);
  if (sq) {
    sq.innerHTML = '';
    sq.appendChild(createImage(symbol));
  }
});

socket.on('turnUpdate', (turn) => {
  currentTurn = turn;
  gameActive = true;
  updateTurnText(turn);
  winMessage.textContent = '';
  removeWinLine();
});

socket.on('boardReset', () => {
  clearBoard();
  gameActive = true;
  winMessage.textContent = '';
  updateTurnText(currentTurn);
  removeWinLine();
});

socket.on('winDetected', ({ winner, line }) => {
  gameActive = false;
  if (winner === 'draw') {
    winMessage.textContent = "It's a draw!";
  } else {
    winMessage.textContent = `Player '${winner.toUpperCase()}' wins!`;
    displayWinLine(line);
  }
  updateTurnText(null);
});

socket.on('playersInfo', (players) => {
  updatePlayersStats(players);
});

socket.on('errorMsg', (msg) => {
  alert(msg);
});

// === Developer Mode (only for "alex") ===
const devModeBtn = document.getElementById('devModeBtn');
if (devModeBtn) {
  devModeBtn.addEventListener('click', () => {
    socket.emit('toggleDevMode');
  });
}
