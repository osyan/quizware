'use strict';

/**
 * End-to-end smoke test for the QuizWare server.
 * Start the server first:  npm start
 * Then run:                npm test
 *
 * Covers: room creation, host key auth, player join, first-buzz-wins,
 * late buzz rejection, scoring, buzz lock, host force-buzz, reset, QR API.
 */

const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000';
const openSockets = [];
let checks = 0;

function ok(label) {
  checks += 1;
  console.log(`  \u2713 ${label}`);
}

function waitFor(socket, event, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for "${event}"`));
    }, timeout);
    function handler(payload) {
      let matched = true;
      try { matched = predicate(payload); } catch { matched = false; }
      if (!matched) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 5000 });
    openSockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function ask(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server not reachable at ${BASE}. Run "npm start" first.`);
}

async function main() {
  await waitForServer();
  ok('server is up');

  /* ---------- create room ---------- */
  const created = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Smoke Quiz',
      teams: [
        { name: 'Red', color: '#ff0000' },
        { name: 'Blue', color: '#0000ff' },
        { name: 'Green', color: '#00aa00' },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const { session, hostKey } = await created.json();
  assert.match(session.id, /^[A-Z0-9]{6}$/);
  assert.ok(hostKey && hostKey.length >= 12, 'host key issued');
  assert.equal(session.hostKey, undefined, 'host key never leaks in state');
  assert.equal(session.teams.length, 3);
  ok(`room created (${session.id}) with host key`);

  /* ---------- wrong host key ---------- */
  const intruder = await connect();
  const badJoin = await ask(intruder, 'join', { role: 'host', sessionId: session.id, key: 'wrong-key' });
  assert.equal(badJoin.ok, false);
  assert.equal(badJoin.reason, 'bad-host-key');
  intruder.disconnect();
  ok('host join rejected without the right key');

  /* ---------- host + players join ---------- */
  const host = await connect();
  const hostJoin = await ask(host, 'join', { role: 'host', sessionId: session.id, key: hostKey });
  assert.equal(hostJoin.ok, true);
  ok('host joined');

  const players = [];
  for (const teamId of ['1', '2', '3']) {
    const player = await connect();
    const joined = await ask(player, 'join', { role: 'player', sessionId: session.id, teamId });
    assert.equal(joined.ok, true);
    assert.equal(joined.team.id, teamId);
    players.push(player);
  }
  ok('3 players joined (one per team)');

  const presence = await (await fetch(`${BASE}/api/session/${session.id}`)).json();
  assert.equal(presence.session.playersByTeam['1'], 1);
  assert.equal(presence.session.playersByTeam['2'], 1);
  assert.equal(presence.session.playersByTeam['3'], 1);
  ok('server tracks player presence per team');

  /* ---------- fastest buzz wins ---------- */
  const winnerOnHost = waitFor(host, 'winner');
  const blueBuzz = await ask(players[1], 'buzz', {});
  const winnerEvent = await winnerOnHost;
  assert.equal(blueBuzz.ok, true);
  assert.equal(winnerEvent.teamId, '2');
  assert.equal(winnerEvent.teamName, 'Blue');
  ok('Blue (team 2) buzzed first and won the round');

  const lateBuzz = await ask(players[0], 'buzz', {});
  assert.equal(lateBuzz.ok, false);
  assert.equal(lateBuzz.reason, 'closed');
  assert.equal(lateBuzz.winner.teamId, '2');
  ok('late buzz from Red rejected — winner stays Blue');

  /* ---------- scoring ---------- */
  const scored = waitFor(host, 'sessionState', (state) => state.scores['2'] === 10);
  host.emit('changeScore', { teamId: '2', amount: 10 });
  await scored;
  ok('host +10 applies to the buzzing team');

  const negative = waitFor(host, 'sessionState', (state) => state.scores['2'] === -5);
  host.emit('changeScore', { teamId: '2', amount: -15 });
  await negative;
  ok('host can subtract points (10 - 15 = -5)');

  /* ---------- buzz lock ---------- */
  const muted = waitFor(host, 'sessionState', (state) => state.buzzMuted === true);
  host.emit('toggleBuzzMute', { muted: true });
  await muted;
  ok('host locked buzzing');

  const resetAfterLock = waitFor(host, 'sessionState', (state) => state.currentWinner === null);
  host.emit('resetBuzz');
  await resetAfterLock;

  const blocked = await ask(players[0], 'buzz', {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'muted');
  ok('player buzz ignored while locked');

  const forced = waitFor(host, 'winner', (event) => event.teamId === '3' && event.source === 'host');
  host.emit('forceBuzz', { teamId: '3' });
  await forced;
  ok('host can force-award the buzz while locked');

  /* ---------- unlock + reset ---------- */
  const unmuted = waitFor(host, 'sessionState', (state) => state.buzzMuted === false);
  host.emit('toggleBuzzMute', { muted: false });
  await unmuted;

  const cleared = waitFor(host, 'sessionState', (state) => state.currentWinner === null);
  host.emit('resetBuzz');
  await cleared;
  const playerReset = await waitFor(players[0], 'sessionState', (state) => state.currentWinner === null);
  assert.equal(playerReset.currentWinner, null);
  ok('reset clears the buzz for every device');

  const greenBuzz = await ask(players[2], 'buzz', {});
  assert.equal(greenBuzz.ok, true);
  ok('buzzing works again after reset');

  /* ---------- read-only APIs ---------- */
  const stateResponse = await fetch(`${BASE}/api/session/${session.id}`);
  assert.equal(stateResponse.status, 200);
  const stateBody = await stateResponse.json();
  assert.equal(stateBody.session.hostKey, undefined);
  assert.equal(stateBody.session.currentWinner.teamId, '3');
  ok('public room state never exposes the host key');

  const missing = await fetch(`${BASE}/api/session/ZZZZZZ`);
  assert.equal(missing.status, 404);
  ok('unknown room returns 404');

  const qr = await fetch(`${BASE}/api/qr?text=${encodeURIComponent('https://example.test/player.html?session=ABC123&teamId=1')}`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type') || '', /image\/png/);
  const qrBytes = Buffer.from(await qr.arrayBuffer());
  assert.ok(qrBytes.length > 500 && qrBytes[0] === 0x89 && qrBytes[1] === 0x50);
  ok('QR endpoint returns a PNG');

  /* ---------- host page served ---------- */
  for (const page of ['/', '/index.html', '/config.html', '/host.html', '/player.html']) {
    const response = await fetch(`${BASE}${page}`);
    assert.equal(response.status, 200, `${page} should be served`);
  }
  ok('all pages are served');

  openSockets.forEach((socket) => socket.disconnect());

  console.log(`\nPASS — ${checks} checks passed.`);
  process.exit(0);
}

main().catch((error) => {
  openSockets.forEach((socket) => socket.disconnect());
  console.error(`\nFAIL — ${error.message}`);
  process.exit(1);
});
