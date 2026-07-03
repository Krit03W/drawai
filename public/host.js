/* global io */
const socket = io();
const $ = (id) => document.getElementById(id);

let state = null;
let timerInterval = null;

const PHASE_LABELS = {
  lobby: 'Waiting (Lobby)',
  generating: 'Generating words…',
  drawing: '✏️ Drawing',
  collecting: '📸 Collecting drawings',
  guessing: '🕵️ Humans guessing',
  ai: '🤖 AI analyzing',
  results: '📊 Round results',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

$('hostLoginBtn').onclick = () => {
  socket.emit('host-login', { password: $('hostPassword').value }, (res) => {
    if (!res.ok) return $('loginError').textContent = res.error;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $('screen-main').classList.add('active');
  });
};
$('hostPassword').addEventListener('keydown', e => { if (e.key === 'Enter') $('hostLoginBtn').click(); });

$('startBtn').onclick = () => {
  socket.emit('host-start-round', {
    drawSeconds: Number($('drawSeconds').value),
    guessSeconds: Number($('guessSeconds').value),
    difficulty: Number($('difficulty').value),
  });
  $('resultsGrid').innerHTML = '';
};
$('forceBtn').onclick = () => socket.emit('host-force-next');
$('resetBtn').onclick = () => {
  if (confirm('Reset all scores and start a new game?')) {
    socket.emit('host-new-game');
    $('resultsGrid').innerHTML = '';
  }
};

socket.on('toast', toast);

socket.on('state', (s) => {
  state = s;
  $('roundNum').textContent = s.round;
  $('phaseLabel').textContent = PHASE_LABELS[s.phase] || s.phase;
  $('aiBadge').innerHTML = s.aiConnected
    ? '🤖 OpenAI: <b style="color:var(--good)">connected</b>'
    : '🤖 OpenAI: <b style="color:var(--bad)">NO API KEY — fallback words!</b>';
  $('startBtn').disabled = !['lobby', 'results'].includes(s.phase);
  $('forceBtn').disabled = !['drawing', 'collecting', 'guessing'].includes(s.phase);
  renderBoard();
  runTimer();
});

function renderBoard() {
  const el = $('hostBoard');
  const sorted = [...state.teams].sort((a, b) => b.score - a.score);
  el.innerHTML = '';
  sorted.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'board-row';
    let status = '';
    if (t.inRound) {
      if (state.phase === 'drawing' || state.phase === 'collecting') {
        status = t.submitted ? '<span class="status">✅ submitted</span>' : '<span class="status">✏️ drawing</span>';
      } else if (state.phase === 'guessing') {
        status = t.guessLocked ? '<span class="status">✅ answered</span>' : '<span class="status">🤔 thinking</span>';
      }
    }
    row.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="dot ${t.players.length ? 'on' : ''}"></span>
      <span class="tname">${esc(t.name)} <span style="color:var(--muted);font-size:.75rem">(${t.players.length} players)</span></span>
      ${status}
      <span class="fooled">fooled AI ${t.aiFooled}×</span>
      <span class="pts">${t.score}</span>`;
    el.appendChild(row);
  });
}

function runTimer() {
  clearInterval(timerInterval);
  const el = $('hostTimer');
  const update = () => {
    if (!state?.phaseEndsAt) { el.textContent = '--'; el.classList.remove('low'); return; }
    const left = Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('low', left <= 10);
  };
  update();
  timerInterval = setInterval(update, 250);
}

socket.on('results', ({ results }) => {
  const grid = $('resultsGrid');
  grid.innerHTML = '';
  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'result-card';
    const conf = r.aiConfidence != null ? ` (${r.aiConfidence}% confident)` : '';
    card.innerHTML = `
      <img src="${r.drawing}" alt="">
      <div class="result-body">
        <div class="team">${esc(r.teamName)}</div>
        <div class="word">Word: ${esc(r.word)}</div>
        <div class="verdict">
          <span class="pill ${r.aiCorrect ? 'bad' : 'good'}">${r.aiCorrect ? 'AI guessed it' : 'AI fooled!'}</span>
          🤖 "${esc(r.aiGuess ?? '-')}"${conf}
        </div>
        <div class="verdict">
          <span class="pill ${r.humanCorrect ? 'good' : 'bad'}">${r.humanCorrect ? 'Human correct' : 'Human wrong'}</span>
          🧑 ${r.guessedByName ? esc(r.guessedByName) + ': ' : ''}"${esc(r.humanGuess || 'no answer')}"
        </div>
        <div class="result-points ${r.points > 0 ? 'plus' : 'zero'}">+${r.points} pts</div>
      </div>`;
    grid.appendChild(card);
  }
});
