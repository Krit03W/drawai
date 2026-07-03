/* global io */
const socket = io();

const $ = (id) => document.getElementById(id);

let myTeamId = null;
let myTeamName = '';
let state = null;
let myWord = null;
let timerInterval = null;

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
const TEAMS = [
  { id: 'nova-core', name: 'Nova Core' },
  { id: 'neural-forge', name: 'Neural Forge' },
  { id: 'quantum-pulse', name: 'Quantum Pulse' },
  { id: 'signal-nexus', name: 'Signal Nexus' },
  { id: 'data-frontier', name: 'Data Frontier' },
  { id: 'rover-vanguard', name: 'Rover Vanguard' },
  { id: 'horizon-prime', name: 'Horizon Prime' },
  { id: 'astro-circuit', name: 'Astro Circuit' },
];

let selectedTeam = null;
const teamGrid = $('teamGrid');
TEAMS.forEach((t, i) => {
  const btn = document.createElement('button');
  btn.className = 'team-btn';
  btn.textContent = `${i + 1}. ${t.name}`;
  btn.onclick = () => {
    selectedTeam = t.id;
    teamGrid.querySelectorAll('.team-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  };
  teamGrid.appendChild(btn);
});

$('loginBtn').onclick = () => {
  const password = $('teamPassword').value;
  const playerName = $('playerName').value.trim();
  if (!selectedTeam) return $('loginError').textContent = 'กรุณาเลือกทีมก่อน';
  if (!playerName) return $('loginError').textContent = 'กรุณาใส่ชื่อผู้เล่น';
  socket.emit('login', { teamId: selectedTeam, password, playerName }, (res) => {
    if (!res.ok) return $('loginError').textContent = res.error;
    myTeamId = selectedTeam;
    myTeamName = res.teamName;
    $('lobbyTeamName').textContent = myTeamName;
    $('drawTeamName').textContent = myTeamName;
    $('guessTeamName').textContent = myTeamName;
    render();
  });
};
$('playerName').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

// ---------------------------------------------------------------------------
// State-driven rendering
// ---------------------------------------------------------------------------
socket.on('state', (s) => { state = s; render(); });
socket.on('toast', toast);

function myTeam() {
  return state?.teams.find(t => t.id === myTeamId);
}

function render() {
  if (!myTeamId || !state) return;
  const me = myTeam();

  switch (state.phase) {
    case 'lobby': showScreen('lobby'); renderLobby(); break;
    case 'generating': showScreen('generating'); break;
    case 'drawing':
    case 'collecting':
      if (!me?.inRound) { showScreen('lobby'); renderLobby(); break; }
      showScreen('draw');
      $('drawRound').textContent = state.round;
      $('drawWord').textContent = myWord || '…';
      setSubmittedUI(me.submitted || state.phase === 'collecting');
      renderBoard($('drawBoard'), true);
      break;
    case 'guessing': showScreen('guess'); break;
    case 'ai': showScreen('ai'); break;
    case 'results': showScreen('results'); renderBoard($('resultsBoard'), false); break;
  }
  runTimer();
}

function renderLobby() {
  const grid = $('lobbyGrid');
  grid.innerHTML = '';
  state.teams.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'lobby-team' + (t.id === myTeamId ? ' me' : '');
    div.innerHTML = `
      <div class="tname">${i + 1}. ${esc(t.name)} ${t.players.length ? '🟢' : '⚪️'}</div>
      <div class="members">${t.players.length ? esc(t.players.join(', ')) : 'ยังไม่มีผู้เล่น'}</div>
      <div style="margin-top:6px;font-weight:700;color:var(--accent2)">${t.score} คะแนน · หลอก AI ได้ ${t.aiFooled} ครั้ง</div>`;
    grid.appendChild(div);
  });
}

function renderBoard(el, showStatus) {
  const sorted = [...state.teams].sort((a, b) => b.score - a.score);
  el.innerHTML = '';
  sorted.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'board-row' + (t.id === myTeamId ? ' me' : '');
    const status = showStatus && t.inRound
      ? (t.submitted ? '<span class="status">✅</span>' : '<span class="status">✏️</span>')
      : '';
    row.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="dot ${t.players.length ? 'on' : ''}"></span>
      <span class="tname">${esc(t.name)}</span>
      ${status}
      <span class="fooled">🤖×${t.aiFooled}</span>
      <span class="pts">${t.score}</span>`;
    el.appendChild(row);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
function runTimer() {
  clearInterval(timerInterval);
  const update = () => {
    const el = state.phase === 'drawing' ? $('drawTimer')
      : state.phase === 'guessing' ? $('guessTimer') : null;
    if (!el || !state.phaseEndsAt) return;
    const left = Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('low', left <= 10);
  };
  update();
  timerInterval = setInterval(update, 250);
}

// ---------------------------------------------------------------------------
// Drawing canvas (collaborative)
// ---------------------------------------------------------------------------
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

let strokes = [];        // local mirror for redraw/undo
let currentColor = '#111111';
let currentSize = 4;
let drawingNow = null;   // { id, lastX, lastY }

function clearCanvas() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
clearCanvas();

function drawSeg(x0, y0, x1, y1, color, size) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
  ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
  ctx.stroke();
}

function drawDot(x, y, color, size) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x * canvas.width, y * canvas.height, size / 2, 0, Math.PI * 2);
  ctx.fill();
}

function redrawAll() {
  clearCanvas();
  for (const s of strokes) {
    if (!s.points.length) continue;
    drawDot(s.points[0].x, s.points[0].y, s.color, s.size);
    for (let i = 1; i < s.points.length; i++) {
      drawSeg(s.points[i - 1].x, s.points[i - 1].y, s.points[i].x, s.points[i].y, s.color, s.size);
    }
  }
}

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width,
    y: (e.clientY - r.top) / r.height,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (state?.phase !== 'drawing' || myTeam()?.submitted) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const { x, y } = canvasPos(e);
  const id = `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  drawingNow = { id, lastX: x, lastY: y };
  strokes.push({ id, color: currentColor, size: currentSize, points: [{ x, y }] });
  drawDot(x, y, currentColor, currentSize);
  socket.emit('stroke-start', { id, x, y, color: currentColor, size: currentSize });
});

canvas.addEventListener('pointermove', (e) => {
  if (!drawingNow) return;
  e.preventDefault();
  const { x, y } = canvasPos(e);
  const s = strokes.find(s => s.id === drawingNow.id);
  if (s) s.points.push({ x, y });
  drawSeg(drawingNow.lastX, drawingNow.lastY, x, y, currentColor, currentSize);
  drawingNow.lastX = x;
  drawingNow.lastY = y;
  socket.emit('stroke-move', { id: drawingNow.id, x, y });
});

const endStroke = () => { drawingNow = null; };
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// remote strokes from teammates
const remoteStrokes = new Map(); // id -> {lastX,lastY,color,size}
socket.on('stroke-start', (d) => {
  strokes.push({ id: d.id, color: d.color, size: d.size, points: [{ x: d.x, y: d.y }] });
  remoteStrokes.set(d.id, { lastX: d.x, lastY: d.y, color: d.color, size: d.size });
  drawDot(d.x, d.y, d.color, d.size);
});
socket.on('stroke-move', (d) => {
  const r = remoteStrokes.get(d.id);
  if (!r) return;
  const s = strokes.find(s => s.id === d.id);
  if (s) s.points.push({ x: d.x, y: d.y });
  drawSeg(r.lastX, r.lastY, d.x, d.y, r.color, r.size);
  r.lastX = d.x;
  r.lastY = d.y;
});
socket.on('replay', ({ strokes: all }) => {
  strokes = all.map(s => ({ ...s, points: [...s.points] }));
  remoteStrokes.clear();
  redrawAll();
});

// tools
document.querySelectorAll('.color-dot').forEach(btn => {
  btn.onclick = () => {
    currentColor = btn.dataset.color;
    document.querySelectorAll('.color-dot').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  };
});
document.querySelectorAll('.size-btn').forEach(btn => {
  btn.onclick = () => {
    currentSize = Number(btn.dataset.size);
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  };
});
$('undoBtn').onclick = () => socket.emit('undo');
$('clearBtn').onclick = () => { if (confirm('ล้างภาพทั้งหมดของทีม?')) socket.emit('clear'); };

$('submitDrawing').onclick = () => {
  if (!confirm('ส่งภาพของทีมเลยหรือไม่? ทุกคนในทีมจะวาดต่อไม่ได้แล้ว')) return;
  socket.emit('submit-drawing', { image: canvas.toDataURL('image/png') });
};

socket.on('team-submitted', () => setSubmittedUI(true));
socket.on('request-snapshot', () => {
  socket.emit('snapshot', { image: canvas.toDataURL('image/png') });
});

function setSubmittedUI(submitted) {
  canvas.classList.toggle('locked', submitted);
  $('tools').style.display = submitted ? 'none' : 'flex';
  $('drawSubmittedMsg').style.display = submitted ? 'block' : 'none';
}

// new round → fresh canvas + word
socket.on('your-word', ({ word }) => {
  myWord = word;
  strokes = [];
  remoteStrokes.clear();
  clearCanvas();
  $('drawWord').textContent = word;
  setSubmittedUI(false);
});

// ---------------------------------------------------------------------------
// Guessing
// ---------------------------------------------------------------------------
socket.on('guess-task', ({ image }) => {
  $('guessImage').src = image;
  $('guessInput').value = '';
  $('guessInputRow').style.display = 'flex';
  $('guessDoneMsg').style.display = 'none';
});

$('guessBtn').onclick = () => {
  const text = $('guessInput').value.trim();
  if (!text) return;
  if (!confirm(`ยืนยันคำตอบของทีม: "${text}" ?`)) return;
  socket.emit('submit-guess', { text });
};
$('guessInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('guessBtn').click(); });

socket.on('team-guessed', ({ guess }) => {
  $('guessInputRow').style.display = 'none';
  $('guessDoneMsg').style.display = 'block';
  $('guessDoneMsg').textContent = `✅ ทีมคุณตอบแล้วว่า "${guess}" — รอทีมอื่น…`;
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
socket.on('results', ({ round, results }) => {
  $('resultsRound').textContent = round;
  const grid = $('resultsGrid');
  grid.innerHTML = '';
  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'result-card';
    const conf = r.aiConfidence != null ? ` (มั่นใจ ${r.aiConfidence}%)` : '';
    card.innerHTML = `
      <img src="${r.drawing}" alt="">
      <div class="result-body">
        <div class="team">${esc(r.teamName)}${r.teamId === myTeamId ? ' ⭐ (ทีมคุณ)' : ''}</div>
        <div class="word">คำจริง: ${esc(r.word)}</div>
        <div class="verdict">
          <span class="pill ${r.aiCorrect ? 'bad' : 'good'}">${r.aiCorrect ? 'AI ทายถูก 😱' : 'หลอก AI สำเร็จ! 🎉'}</span>
          🤖 "${esc(r.aiGuess ?? '-')}"${conf}
        </div>
        <div class="verdict">
          <span class="pill ${r.humanCorrect ? 'good' : 'bad'}">${r.humanCorrect ? 'มนุษย์ทายถูก +โบนัส' : 'มนุษย์ทายผิด'}</span>
          🧑 ${r.guessedByName ? esc(r.guessedByName) + ': ' : ''}"${esc(r.humanGuess || 'ไม่ได้ตอบ')}"
        </div>
        <div class="result-points ${r.points > 0 ? 'plus' : 'zero'}">+${r.points} คะแนน</div>
      </div>`;
    grid.appendChild(card);
  }
  showScreen('results');
  if (state) renderBoard($('resultsBoard'), false);
});
