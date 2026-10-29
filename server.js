'use strict';

/**
 * QuizWare server
 * - Express static hosting for the host / player pages
 * - Socket.IO room-based real-time buzz + score state
 * - In-memory sessions (TTL 24h), no database
 *
 * Works both at http://localhost:4000/ and behind a reverse proxy prefix
 * such as https://quizware.syss.hk/quizware/ because every frontend URL
 * is relative to the page.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 4000);
const BIND = process.env.BIND || '0.0.0.0';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Public-demo protection (a self-hosted event server will never hit these).
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 500);
const CREATE_LIMIT = Number(process.env.CREATE_LIMIT || 20);
const CREATE_WINDOW_MS = 10 * 60 * 1000;

const MIN_TEAMS = 2;
const MAX_TEAMS = 12;
const MAX_TITLE_LENGTH = 60;
const MAX_TEAM_NAME_LENGTH = 24;
const MAX_SCORE_STEP = 1000;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const DEFAULT_COLORS = [
  '#ff9999', '#99ccff', '#ffe680', '#b3e6b3', '#d9b3ff', '#ffc299',
  '#80d4d4', '#f2a2c0', '#c9d6a3', '#a3b8f0', '#f0c9a3', '#b0b0b0',
];

/** @type {Map<string, object>} */
const sessions = new Map();
/** @type {Map<string, {count: number, resetAt: number}>} ip -> room-creation quota */
const createHits = new Map();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  }
  return out;
}

function newRoomCode() {
  let code = randomCode();
  while (sessions.has(code)) code = randomCode();
  return code;
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanColor(value, fallback) {
  const color = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function normalizeRoomCode(value) {
  return cleanText(value, 12).toUpperCase();
}

function playersByTeam(session) {
  const counts = {};
  for (const team of session.teams) counts[team.id] = 0;
  for (const player of session.players.values()) {
    if (counts[player.teamId] !== undefined) counts[player.teamId] += 1;
  }
  return counts;
}

/** Public view of a session. Never includes hostKey. */
function snapshot(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    teams: session.teams.map((team) => ({ ...team })),
    scores: { ...session.scores },
    currentWinner: session.currentWinner ? { ...session.currentWinner } : null,
    buzzStartedAt: session.buzzStartedAt,
    buzzMuted: session.buzzMuted,
    round: session.round,
    playersByTeam: playersByTeam(session),
    serverTime: Date.now(),
  };
}

function createSession(body) {
  const rawTeams = Array.isArray(body?.teams) ? body.teams : [];
  const teams = rawTeams.slice(0, MAX_TEAMS).map((team, index) => ({
    id: String(index + 1),
    name: cleanText(team?.name, MAX_TEAM_NAME_LENGTH) || `Team ${index + 1}`,
    color: cleanColor(team?.color, DEFAULT_COLORS[index % DEFAULT_COLORS.length]),
  }));

  while (teams.length < MIN_TEAMS) {
    const index = teams.length;
    teams.push({
      id: String(index + 1),
      name: `Team ${index + 1}`,
      color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    });
  }

  const session = {
    id: newRoomCode(),
    hostKey: crypto.randomBytes(12).toString('base64url'),
    title: cleanText(body?.title, MAX_TITLE_LENGTH) || 'QuizWare Session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    teams,
    scores: Object.fromEntries(teams.map((team) => [team.id, 0])),
    currentWinner: null,
    buzzStartedAt: null,
    buzzMuted: false,
    buzzSeq: 0,
    round: 1,
    /** @type {Map<string, {teamId: string, joinedAt: number}>} socket.id -> player */
    players: new Map(),
    /** @type {Set<string>} connected host socket ids */
    hostSockets: new Set(),
  };

  sessions.set(session.id, session);
  return session;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  pingInterval: 10000,
  pingTimeout: 8000,
});

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Behind Cloudflare / Nginx, set TRUST_PROXY=1 so rate limits see the real client IP.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sessions: sessions.size, uptime: Math.round(process.uptime()) });
});

app.post('/api/session', (req, res) => {
  if (sessions.size >= MAX_SESSIONS) return res.status(503).json({ error: 'server-busy' });

  const ip = req.ip || 'unknown';
  const now = Date.now();
  const quota = createHits.get(ip);
  if (!quota || quota.resetAt <= now) {
    createHits.set(ip, { count: 1, resetAt: now + CREATE_WINDOW_MS });
  } else if (quota.count >= CREATE_LIMIT) {
    return res.status(429).json({ error: 'rate-limited' });
  } else {
    quota.count += 1;
  }

  const session = createSession(req.body);
  res.status(201).json({ session: snapshot(session), hostKey: session.hostKey });
});

app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(normalizeRoomCode(req.params.id));
  if (!session) return res.status(404).json({ error: 'room-not-found' });
  res.json({ session: snapshot(session) });
});

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text ?? '').slice(0, 512);
  if (!text) return res.status(400).json({ error: 'missing-text' });
  try {
    const png = await QRCode.toBuffer(text, {
      type: 'png',
      width: 420,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    });
    res.type('png').set('Cache-Control', 'public, max-age=600').send(png);
  } catch (error) {
    res.status(500).json({ error: 'qr-failed' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((req, res) => res.status(404).send('Not found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err?.status || 500;
  res.status(status).json({ error: status === 400 ? 'bad-request' : 'server-error' });
});

/* ------------------------------------------------------------------ *
 * Socket.IO
 * ------------------------------------------------------------------ */

function currentSession(socket) {
  if (!socket.data.sessionId) return null;
  return sessions.get(socket.data.sessionId) || null;
}

function isHost(socket) {
  return socket.data.role === 'host';
}

function broadcastState(session) {
  io.to(session.id).emit('sessionState', snapshot(session));
}

function reject(socket, text) {
  socket.emit('errorMessage', { text });
}

function applyWinner(session, team, source) {
  const now = Date.now();
  session.currentWinner = {
    teamId: team.id,
    teamName: team.name,
    teamColor: team.color,
    ts: now,
    seq: (session.buzzSeq += 1),
    source,
  };
  session.buzzStartedAt = now;
  session.updatedAt = now;
  io.to(session.id).emit('winner', { ...session.currentWinner });
  broadcastState(session);
  return session.currentWinner;
}

io.on('connection', (socket) => {
  socket.data.role = null;
  socket.data.sessionId = null;
  socket.data.teamId = null;

  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const role = payload?.role === 'host' ? 'host' : payload?.role === 'player' ? 'player' : null;
    const sessionId = normalizeRoomCode(payload?.sessionId);

    if (!role) {
      reject(socket, 'Unknown role.');
      return reply({ ok: false, reason: 'bad-role' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      reject(socket, `Room ${sessionId || '(empty)'} not found. Ask the host for a new room code.`);
      return reply({ ok: false, reason: 'room-not-found' });
    }

    if (role === 'host') {
      if (!payload?.key || payload.key !== session.hostKey) {
        reject(socket, 'Host key invalid. Open the host page from the setup link.');
        return reply({ ok: false, reason: 'bad-host-key' });
      }
      socket.data.role = 'host';
      socket.data.sessionId = session.id;
      socket.data.teamId = null;
      session.hostSockets.add(socket.id);
      socket.join(session.id);
      socket.emit('sessionState', snapshot(session));
      broadcastState(session);
      return reply({ ok: true, role: 'host', session: snapshot(session) });
    }

    const teamId = cleanText(payload?.teamId, 8);
    const team = session.teams.find((item) => item.id === teamId);
    if (!team) {
      reject(socket, 'That team no longer exists. Scan the QR code again.');
      return reply({ ok: false, reason: 'bad-team' });
    }

    socket.data.role = 'player';
    socket.data.sessionId = session.id;
    socket.data.teamId = team.id;
    session.players.set(socket.id, { teamId: team.id, joinedAt: Date.now() });
    socket.join(session.id);
    socket.emit('sessionState', snapshot(session));
    broadcastState(session);
    return reply({
      ok: true,
      role: 'player',
      team: { ...team },
      muted: session.buzzMuted,
      winner: session.currentWinner,
    });
  });

  socket.on('buzz', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const session = currentSession(socket);

    if (!session || socket.data.role !== 'player') return reply({ ok: false, reason: 'not-joined' });
    if (session.buzzMuted) return reply({ ok: false, reason: 'muted' });
    if (session.currentWinner) {
      return reply({ ok: false, reason: 'closed', winner: { ...session.currentWinner } });
    }

    const team = session.teams.find((item) => item.id === socket.data.teamId);
    if (!team) return reply({ ok: false, reason: 'no-team' });

    // Server arrival order decides the winner: first valid buzz wins.
    const winner = applyWinner(session, team, 'player');
    return reply({ ok: true, winner: { ...winner } });
  });

  socket.on('forceBuzz', (payload) => {
    const session = currentSession(socket);
    if (!session || !isHost(socket)) return;
    const team = session.teams.find((item) => item.id === cleanText(payload?.teamId, 8));
    if (!team) return;
    applyWinner(session, team, 'host');
  });

  socket.on('resetBuzz', () => {
    const session = currentSession(socket);
    if (!session || !isHost(socket)) return;
    session.currentWinner = null;
    session.buzzStartedAt = null;
    session.round += 1;
    session.updatedAt = Date.now();
    io.to(session.id).emit('reset', { round: session.round });
    broadcastState(session);
  });

  socket.on('changeScore', (payload) => {
    const session = currentSession(socket);
    if (!session || !isHost(socket)) return;
    const teamId = cleanText(payload?.teamId, 8);
    const amount = Math.trunc(Number(payload?.amount));
    if (session.scores[teamId] === undefined) return;
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_SCORE_STEP) return;
    session.scores[teamId] += amount;
    session.updatedAt = Date.now();
    io.to(session.id).emit('scoreChange', { teamId, amount, score: session.scores[teamId] });
    broadcastState(session);
  });

  socket.on('toggleBuzzMute', (payload) => {
    const session = currentSession(socket);
    if (!session || !isHost(socket)) return;
    session.buzzMuted = typeof payload?.muted === 'boolean' ? payload.muted : !session.buzzMuted;
    session.updatedAt = Date.now();
    broadcastState(session);
  });

  socket.on('disconnect', () => {
    const session = currentSession(socket);
    if (!session) return;
    if (socket.data.role === 'host') session.hostSockets.delete(socket.id);
    if (socket.data.role === 'player') session.players.delete(socket.id);
    broadcastState(session);
  });
});

/* ------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------ */

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff && session.players.size === 0) sessions.delete(id);
  }
  const now = Date.now();
  for (const [ip, quota] of createHits) {
    if (quota.resetAt <= now) createHits.delete(ip);
  }
}, CLEANUP_INTERVAL_MS).unref();

server.listen(PORT, BIND, () => {
  console.log(`QuizWare listening on http://${BIND}:${PORT}`);
});
