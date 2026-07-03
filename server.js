import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { pickUniqueWords } from './words.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'admin123';
const PORT = process.env.PORT || 3000;

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------
const TEAM_DEFS = [
  { id: 'nova-core',      name: 'Nova Core',      password: 'nova01' },
  { id: 'neural-forge',   name: 'Neural Forge',   password: 'forge02' },
  { id: 'quantum-pulse',  name: 'Quantum Pulse',  password: 'pulse03' },
  { id: 'signal-nexus',   name: 'Signal Nexus',   password: 'nexus04' },
  { id: 'data-frontier',  name: 'Data Frontier',  password: 'data05' },
  { id: 'rover-vanguard', name: 'Rover Vanguard', password: 'rover06' },
  { id: 'horizon-prime',  name: 'Horizon Prime',  password: 'prime07' },
  { id: 'astro-circuit',  name: 'Astro Circuit',  password: 'circuit08' },
];

const POINTS_AI_FOOLED = 10;
const POINTS_HUMAN_CORRECT = 5;

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
function freshRoundData() {
  return {
    word: null,
    strokes: [],          // [{ id, color, size, points: [{x,y},...] }]
    drawing: null,        // dataURL
    submitted: false,
    guessTargetId: null,  // team whose drawing this team must guess
    guess: null,          // this team's guess about the drawing they received
    guessLocked: false,
    // results (about THIS team's own drawing)
    guessedByName: null,
    humanGuess: null,
    humanCorrect: false,
    aiGuess: null,
    aiConfidence: null,
    aiCorrect: false,
    points: 0,
  };
}

const game = {
  phase: 'lobby', // lobby | drawing | guessing | ai | results
  round: 0,
  phaseEndsAt: null,
  drawSeconds: 120,
  guessSeconds: 45,
  difficulty: 2, // 1 easy … 5 nearly impossible
  usedWords: [],
  teams: {},
};

const DIFFICULTY_SPECS = {
  1: 'VERY EASY: extremely common, simple objects a small child can draw in seconds (e.g. sun, cat, ball, house).',
  2: 'EASY: common concrete things — animals, food, vehicles, everyday objects (e.g. monkey, pizza, rocket).',
  3: 'MEDIUM: concrete but detailed things that take effort to draw recognizably (e.g. lighthouse, scarecrow, submarine).',
  4: 'HARD: compound scenes, actions or phenomena that are tricky to convey in a sketch (e.g. traffic jam, earthquake, sleepwalking).',
  5: 'EXTREME: abstract concepts, feelings or invisible ideas that are nearly impossible to draw (e.g. gravity, sarcasm, nostalgia, democracy).',
};
for (const t of TEAM_DEFS) {
  game.teams[t.id] = {
    ...t,
    players: new Map(), // socketId -> playerName
    score: 0,
    aiFooled: 0,
    rd: freshRoundData(),
  };
}

let phaseTimer = null;
let snapshotTimer = null;

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });

// no-cache: browsers must revalidate JS/CSS every load, so redeploys reach
// every device without a hard refresh (ETag still avoids re-downloading).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function teamRoom(id) { return `team:${id}`; }

function publicState() {
  return {
    phase: game.phase,
    round: game.round,
    phaseEndsAt: game.phaseEndsAt,
    drawSeconds: game.drawSeconds,
    guessSeconds: game.guessSeconds,
    difficulty: game.difficulty,
    aiConnected: !!OPENAI_API_KEY,
    teams: TEAM_DEFS.map(({ id }) => {
      const t = game.teams[id];
      return {
        id,
        name: t.name,
        players: [...t.players.values()],
        score: t.score,
        aiFooled: t.aiFooled,
        submitted: t.rd.submitted,
        guessLocked: t.rd.guessLocked,
        inRound: !!t.rd.word,
      };
    }),
  };
}

function broadcastState() {
  io.emit('state', publicState());
}

function activeTeamIds() {
  return TEAM_DEFS.map(t => t.id).filter(id => game.teams[id].players.size > 0);
}

function clearTimers() {
  if (phaseTimer) { clearTimeout(phaseTimer); phaseTimer = null; }
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9ก-๙\s]/g, '')
    .replace(/\s+/g, ' ');
}

function stripPlural(w) {
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

// Quick string-level match (English). Thai/synonym matches are handled by the
// AI judge as a second pass.
function stringMatch(word, guess) {
  const w = stripPlural(normalizeText(word));
  const g = stripPlural(normalizeText(guess));
  if (!w || !g) return false;
  if (w === g) return true;
  const gWords = g.split(' ').map(stripPlural);
  return gWords.includes(w) || (w.length >= 4 && g.includes(w));
}

// ---------------------------------------------------------------------------
// OpenAI calls
// ---------------------------------------------------------------------------
async function openaiChat(messages, maxTokens = 300, temperature = 0) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function generateWords(count) {
  const used = game.usedWords;
  if (!OPENAI_API_KEY) {
    io.to('hosts').emit('toast', '⚠️ No OPENAI_API_KEY — using built-in fallback words');
    return pickUniqueWords(count, game.difficulty, used);
  }
  try {
    const out = await openaiChat([
      {
        role: 'user',
        content:
          `Generate exactly ${count + 4} DISTINCT, creative English words/phrases for a drawing party game. ` +
          `Difficulty level ${game.difficulty}/5 — ${DIFFICULTY_SPECS[game.difficulty]} ` +
          `Every word must match that difficulty level. One to three words each. Vary the categories; be unpredictable. ` +
          (used.length ? `Do NOT use any of these already-used words: ${used.join(', ')}. ` : '') +
          `Respond as JSON: {"words": ["...", ...]}`,
      },
    ], 400, 1.0);
    const words = (out.words || []).map(w => String(w).trim()).filter(Boolean);
    const usedSet = new Set(used.map(w => w.toLowerCase()));
    const unique = [...new Set(words.map(w => w.toLowerCase()))]
      .filter(lw => !usedSet.has(lw))
      .map(lw => words.find(w => w.toLowerCase() === lw));
    if (unique.length >= count) return unique.slice(0, count);
    return [...unique, ...pickUniqueWords(count - unique.length, game.difficulty, [...used, ...unique])];
  } catch (err) {
    console.error('Word generation failed, using fallback list:', err.message);
    io.to('hosts').emit('toast', `⚠️ OpenAI word generation failed (${err.message.slice(0, 80)}) — using fallback words`);
    return pickUniqueWords(count, game.difficulty, used);
  }
}

async function aiGuessDrawing(dataURL) {
  if (!OPENAI_API_KEY) return { guess: '(no API key)', confidence: 0 };
  try {
    const out = await openaiChat([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'This is a hand-drawn sketch from a drawing game. Guess what single object, animal or thing it depicts. ' +
              'Respond as JSON: {"guess": "<one or two English words>", "confidence": <0-100 integer>}',
          },
          { type: 'image_url', image_url: { url: dataURL, detail: 'low' } },
        ],
      },
    ]);
    return {
      guess: String(out.guess || '?').trim(),
      confidence: Math.max(0, Math.min(100, Number(out.confidence) || 0)),
    };
  } catch (err) {
    console.error('AI vision guess failed:', err.message);
    return { guess: '(AI error)', confidence: 0 };
  }
}

// Judge whether guesses match the word, allowing Thai answers and synonyms.
// pairs: [{ word, guess }] -> [bool]
async function judgeMatches(pairs) {
  const results = pairs.map(p => stringMatch(p.word, p.guess));
  const pending = pairs
    .map((p, i) => ({ ...p, i }))
    .filter(p => !results[p.i] && normalizeText(p.guess));
  if (!pending.length || !OPENAI_API_KEY) return results;
  try {
    const out = await openaiChat([
      {
        role: 'user',
        content:
          'You are a strict quiz judge. For each item, decide if "guess" names the same object as "answer". ' +
          'The guess may be in Thai or English; direct translations and true synonyms count as correct. ' +
          'Mark FALSE if the guess is a different object, only loosely related, vague, or a non-answer ' +
          '(e.g. "I don\'t know", "ไม่รู้", "?", "something"). ' +
          `Items: ${JSON.stringify(pending.map(p => ({ answer: p.word, guess: p.guess })))} ` +
          'Respond as JSON: {"matches": [true/false, ...]} in the same order, one entry per item.',
      },
    ]);
    const matches = out.matches || [];
    pending.forEach((p, k) => { if (matches[k] === true) results[p.i] = true; });
  } catch (err) {
    console.error('Match judging failed, using string match only:', err.message);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------
async function startRound(drawSeconds, guessSeconds, difficulty) {
  const active = activeTeamIds();
  if (active.length < 2) {
    io.to('hosts').emit('toast', 'At least 2 teams need players online to start');
    return;
  }
  clearTimers();
  game.round += 1;
  game.drawSeconds = Math.max(30, Math.min(600, drawSeconds || 120));
  game.guessSeconds = Math.max(15, Math.min(300, guessSeconds || 45));
  game.difficulty = DIFFICULTY_SPECS[difficulty] ? difficulty : game.difficulty;

  for (const id of Object.keys(game.teams)) game.teams[id].rd = freshRoundData();

  game.phase = 'generating';
  broadcastState();

  const words = await generateWords(active.length);
  game.usedWords.push(...words);

  active.forEach((id, i) => {
    const t = game.teams[id];
    t.rd.word = words[i];
    io.to(teamRoom(id)).emit('your-word', { word: words[i] });
  });

  game.phase = 'drawing';
  game.phaseEndsAt = Date.now() + game.drawSeconds * 1000;
  phaseTimer = setTimeout(endDrawing, game.drawSeconds * 1000);
  broadcastState();
  console.log(`Round ${game.round} started: ${active.length} teams, words: ${words.join(', ')}`);
}

function maybeFinishDrawing() {
  const drawingTeams = activeRoundTeamIds();
  if (drawingTeams.every(id => game.teams[id].rd.submitted)) endDrawing();
}

function activeRoundTeamIds() {
  return TEAM_DEFS.map(t => t.id).filter(id => game.teams[id].rd.word);
}

function endDrawing() {
  if (game.phase !== 'drawing') return;
  clearTimers();
  game.phase = 'collecting';
  game.phaseEndsAt = null;
  broadcastState();

  // Ask teams that never pressed submit for a snapshot of their canvas.
  const waiting = activeRoundTeamIds().filter(id => !game.teams[id].rd.drawing);
  if (waiting.length === 0) return startGuessing();

  for (const id of waiting) io.to(teamRoom(id)).emit('request-snapshot');
  snapshotTimer = setTimeout(startGuessing, 5000);
}

function maybeStartGuessing() {
  if (game.phase !== 'collecting') return;
  const waiting = activeRoundTeamIds().filter(id => !game.teams[id].rd.drawing);
  if (waiting.length === 0) startGuessing();
}

function startGuessing() {
  if (game.phase !== 'collecting') return;
  clearTimers();

  // Only teams that produced a drawing take part in the rotation.
  const ids = activeRoundTeamIds().filter(id => game.teams[id].rd.drawing);
  if (ids.length < 2) {
    io.emit('toast', 'Not enough drawings submitted (need at least 2 teams) — round ended');
    game.phase = 'lobby';
    broadcastState();
    return;
  }

  // Round robin: team i guesses the drawing of team i+1.
  ids.forEach((id, i) => {
    const target = ids[(i + 1) % ids.length];
    game.teams[id].rd.guessTargetId = target;
    io.to(teamRoom(id)).emit('guess-task', { image: game.teams[target].rd.drawing });
  });

  game.phase = 'guessing';
  game.phaseEndsAt = Date.now() + game.guessSeconds * 1000;
  phaseTimer = setTimeout(endGuessing, game.guessSeconds * 1000);
  broadcastState();
}

function maybeFinishGuessing() {
  const guessers = activeRoundTeamIds().filter(id => game.teams[id].rd.guessTargetId);
  if (guessers.every(id => game.teams[id].rd.guessLocked)) endGuessing();
}

async function endGuessing() {
  if (game.phase !== 'guessing') return;
  clearTimers();
  game.phase = 'ai';
  game.phaseEndsAt = null;
  broadcastState();

  const ids = activeRoundTeamIds().filter(id => game.teams[id].rd.drawing);

  // 1) AI vision guesses every drawing (in parallel).
  const aiResults = await Promise.all(
    ids.map(id => aiGuessDrawing(game.teams[id].rd.drawing)),
  );
  ids.forEach((id, i) => {
    game.teams[id].rd.aiGuess = aiResults[i].guess;
    game.teams[id].rd.aiConfidence = aiResults[i].confidence;
  });

  // 2) Judge correctness of AI guesses and human guesses in one batch.
  const aiPairs = ids.map(id => ({ word: game.teams[id].rd.word, guess: game.teams[id].rd.aiGuess }));
  const humanPairs = [];
  for (const id of ids) {
    const guesserId = ids.find(g => game.teams[g].rd.guessTargetId === id);
    const t = game.teams[id];
    t.rd.guessedByName = guesserId ? game.teams[guesserId].name : null;
    t.rd.humanGuess = guesserId ? game.teams[guesserId].rd.guess : null;
    humanPairs.push({ word: t.rd.word, guess: t.rd.humanGuess || '' });
  }
  const verdicts = await judgeMatches([...aiPairs, ...humanPairs]);

  // 3) Score.
  ids.forEach((id, i) => {
    const t = game.teams[id];
    t.rd.aiCorrect = verdicts[i];
    t.rd.humanCorrect = verdicts[ids.length + i];
    let pts = 0;
    if (!t.rd.aiCorrect) { pts += POINTS_AI_FOOLED; t.aiFooled += 1; }
    if (t.rd.humanCorrect) pts += POINTS_HUMAN_CORRECT;
    t.rd.points = pts;
    t.score += pts;
  });

  showResults();
}

function showResults() {
  game.phase = 'results';
  game.phaseEndsAt = null;

  const ids = activeRoundTeamIds().filter(id => game.teams[id].rd.drawing);
  const results = ids.map(id => {
    const t = game.teams[id];
    return {
      teamId: id,
      teamName: t.name,
      word: t.rd.word,
      drawing: t.rd.drawing,
      guessedByName: t.rd.guessedByName,
      humanGuess: t.rd.humanGuess,
      humanCorrect: t.rd.humanCorrect,
      aiGuess: t.rd.aiGuess,
      aiConfidence: t.rd.aiConfidence,
      aiCorrect: t.rd.aiCorrect,
      points: t.rd.points,
    };
  });

  io.emit('results', { round: game.round, results });
  broadcastState();
  console.log(`Round ${game.round} results:`, results.map(r =>
    `${r.teamName}: "${r.word}" AI="${r.aiGuess}"(${r.aiCorrect ? 'hit' : 'MISS'}) human="${r.humanGuess}"(${r.humanCorrect}) +${r.points}`).join(' | '));
}

function resetGame() {
  clearTimers();
  game.phase = 'lobby';
  game.round = 0;
  game.phaseEndsAt = null;
  game.usedWords = [];
  for (const id of Object.keys(game.teams)) {
    const t = game.teams[id];
    t.score = 0;
    t.aiFooled = 0;
    t.rd = freshRoundData();
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// Socket handling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  let teamId = null;
  let isHost = false;

  socket.on('login', ({ teamId: id, password, playerName }, cb) => {
    const t = game.teams[id];
    if (!t) return cb?.({ ok: false, error: 'Team not found' });
    if (t.password !== String(password || '').trim()) {
      return cb?.({ ok: false, error: 'Incorrect password' });
    }
    const name = String(playerName || '').trim().slice(0, 24) || 'Player';
    teamId = id;
    t.players.set(socket.id, name);
    socket.join(teamRoom(id));
    cb?.({ ok: true, teamName: t.name });

    // Sync current round context for (re)joining players.
    socket.emit('state', publicState());
    if (t.rd.word) socket.emit('your-word', { word: t.rd.word });
    if (t.rd.strokes.length) socket.emit('replay', { strokes: t.rd.strokes });
    if (game.phase === 'guessing' && t.rd.guessTargetId) {
      socket.emit('guess-task', { image: game.teams[t.rd.guessTargetId].rd.drawing });
    }
    broadcastState();
  });

  socket.on('host-login', ({ password }, cb) => {
    if (String(password || '') !== HOST_PASSWORD) {
      return cb?.({ ok: false, error: 'Incorrect host password' });
    }
    isHost = true;
    socket.join('hosts');
    cb?.({ ok: true });
    socket.emit('state', publicState());
  });

  // --- host controls ---
  socket.on('host-start-round', ({ drawSeconds, guessSeconds, difficulty } = {}) => {
    if (!isHost) return;
    if (!['lobby', 'results'].includes(game.phase)) return;
    startRound(Number(drawSeconds), Number(guessSeconds), Number(difficulty));
  });

  socket.on('host-force-next', () => {
    if (!isHost) return;
    if (game.phase === 'drawing') endDrawing();
    else if (game.phase === 'collecting') startGuessing();
    else if (game.phase === 'guessing') endGuessing();
  });

  socket.on('host-new-game', () => { if (isHost) resetGame(); });

  // --- drawing ---
  socket.on('stroke-start', (d) => {
    if (!teamId || game.phase !== 'drawing') return;
    const t = game.teams[teamId];
    if (t.rd.submitted) return;
    t.rd.strokes.push({ id: d.id, color: d.color, size: d.size, points: [{ x: d.x, y: d.y }] });
    socket.to(teamRoom(teamId)).emit('stroke-start', d);
  });

  socket.on('stroke-move', (d) => {
    if (!teamId || game.phase !== 'drawing') return;
    const t = game.teams[teamId];
    if (t.rd.submitted) return;
    const s = t.rd.strokes.find(s => s.id === d.id);
    if (s) s.points.push({ x: d.x, y: d.y });
    socket.to(teamRoom(teamId)).emit('stroke-move', d);
  });

  socket.on('undo', () => {
    if (!teamId || game.phase !== 'drawing') return;
    const t = game.teams[teamId];
    if (t.rd.submitted || !t.rd.strokes.length) return;
    t.rd.strokes.pop();
    io.to(teamRoom(teamId)).emit('replay', { strokes: t.rd.strokes });
  });

  socket.on('clear', () => {
    if (!teamId || game.phase !== 'drawing') return;
    const t = game.teams[teamId];
    if (t.rd.submitted) return;
    t.rd.strokes = [];
    io.to(teamRoom(teamId)).emit('replay', { strokes: [] });
  });

  socket.on('submit-drawing', ({ image }) => {
    if (!teamId || game.phase !== 'drawing') return;
    const t = game.teams[teamId];
    if (t.rd.submitted || !t.rd.word) return;
    if (typeof image !== 'string' || !image.startsWith('data:image/png')) return;
    t.rd.drawing = image;
    t.rd.submitted = true;
    io.to(teamRoom(teamId)).emit('team-submitted');
    broadcastState();
    maybeFinishDrawing();
  });

  socket.on('snapshot', ({ image }) => {
    if (!teamId || game.phase !== 'collecting') return;
    const t = game.teams[teamId];
    if (t.rd.drawing || !t.rd.word) return;
    if (typeof image !== 'string' || !image.startsWith('data:image/png')) return;
    t.rd.drawing = image;
    t.rd.submitted = true;
    maybeStartGuessing();
  });

  // --- guessing ---
  socket.on('submit-guess', ({ text }) => {
    if (!teamId || game.phase !== 'guessing') return;
    const t = game.teams[teamId];
    if (!t.rd.guessTargetId || t.rd.guessLocked) return;
    t.rd.guess = String(text || '').trim().slice(0, 60);
    t.rd.guessLocked = true;
    io.to(teamRoom(teamId)).emit('team-guessed', { guess: t.rd.guess });
    broadcastState();
    maybeFinishGuessing();
  });

  socket.on('disconnect', () => {
    if (teamId && game.teams[teamId]) {
      game.teams[teamId].players.delete(socket.id);
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🎨 AI Can't Guess This! — running at http://localhost:${PORT}`);
  console.log(`   Player page : http://localhost:${PORT}/`);
  console.log(`   Host page   : http://localhost:${PORT}/host  (password: ${HOST_PASSWORD})`);
  console.log(`   OpenAI      : ${OPENAI_API_KEY ? 'connected' : 'NO API KEY — using fallback words, AI guess disabled'}\n`);
});
