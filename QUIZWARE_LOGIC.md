# Quizware — Logic & Workflow Export

This document describes the full logic and workflow of the Quizware system so another agent can understand and continue development.

## 1. Purpose

Quizware is a web-based quiz buzzer system for schools and educational use. It is a new online design, independent of old USB buzzer hardware. Players join with mobile devices via QR codes, while the host controls the session from a projector or laptop.

## 2. Tech Stack

- Backend: Node.js + Express + Socket.IO
- Frontend: Plain HTML/CSS/JS (no framework)
- Real-time: Socket.IO (WebSocket with polling fallback)
- Static files: served from `public/`
- QR codes: generated server-side with the `qrcode` npm package (`GET /api/qr`)
- Buzz sound: synthesised on the host page with the Web Audio API (no audio file)
- Session storage: in-memory `Map` (no database)
- Session cleanup: automatic after 24 hours
- Deployment: Debian VM, Nginx reverse proxy, Cloudflare DNS/analytics

## 3. File Structure

```
quizware/
├── server.js            # Express + Socket.IO, in-memory sessions
├── package.json
├── README.md            # run / deploy / troubleshoot
├── test/smoke.js        # end-to-end test (npm test)
└── public/
    ├── index.html       # landing page + join by room code
    ├── config.html      # host setup page (creates the room)
    ├── host.html        # host control page (projector)
    └── player.html      # player device page (single BUZZ button)
```

There is no `beep.mp3`: the host page synthesises the buzz beep with the Web Audio API so the
app has no binary assets and works offline.

Every URL inside the pages is relative (`api/session`, `socket.io/socket.io.js`,
`player.html?...`), which is what lets the same build run at `localhost:4000/` and behind the
`/quizware/` Nginx prefix.

## 4. Core Workflow

### 4.1 Setup (config.html)
1. Host opens `/quizware/config.html`.
2. Host enters quiz title, number of teams, team names, and team colors (the last setup is
   remembered in `localStorage`).
3. Host clicks "Create room & open host screen".
4. Frontend sends `POST /api/session` with `{ title, teams: [{name, color}] }`.
5. Server creates a session with a random 6-character room code (alphabet excludes I/O/0/1) and a
   random **host key**.
6. Server returns `{ session, hostKey }`. `session` never contains the host key.
7. Frontend shows the room code, a QR code, and an "Open host screen" button pointing to
   `host.html?session=<ID>&key=<hostKey>`.

### 4.2 Host Joins (host.html)
1. Host opens `host.html?session=<ID>&key=<hostKey>`.
2. On Socket.IO connect, host emits `join` with `{ role: 'host', sessionId, key }`.
3. Server compares `key` with `session.hostKey`; a wrong/missing key is rejected with
   `errorMessage` and the page shows a fatal "host screen not connected" panel.
4. Server records the socket in `session.hostSockets`, joins the room, and sends `sessionState`.
5. Host page renders team boxes with names, colors, scores, and the number of connected players.

### 4.3 Player Joins (player.html)
1. Host toggles QR mode to show QR codes for each team.
2. Each QR code points to `player.html?session=<ID>&teamId=<N>` (no host key).
3. Player scans QR code with mobile device, or types the room code on `index.html`
   (`player.html?session=<ID>`), in which case the page offers a team picker.
4. On Socket.IO connect, player emits `join` with `{ role: 'player', sessionId, teamId }`
   (the `join` ack returns `{ ok, team, muted, winner }`).
5. Server validates session and team, joins the room, and sends `sessionState`.
6. Player page shows room code, team name and team color; the choice is remembered in
   `localStorage` so a refresh/reconnect keeps the same team.
7. Any number of players may join the same team.

### 4.4 Buzzing
- Player taps BUZZ (the page listens to `pointerdown` for minimum latency) → emits `buzz` with an ack callback.
- Server checks: socket joined as player, team exists, buzz not muted, no current winner.
- First valid buzz wins: server sets `currentWinner` and stamps `ts` (server clock) plus a
  monotonic `seq`. Fairness is decided by **server arrival order**, never by phone clocks.
- Server broadcasts `winner` and `sessionState` to the room, and replies to the ack.
- Host page on `winner`: renders the buzz banner (team name + color), shows elapsed time since
  `ts` (corrected by the server/client clock offset) and plays the synthesised beep (once per `seq`).
- Player pages: disable BUZZ, show "You buzzed first" or "<Team> buzzed first".
- Later buzzes are rejected with `{ ok:false, reason:'closed', winner }`; the page shows "TOO LATE".

### 4.5 Host Manual Buzz
- Host clicks any team box on host page → emits `forceBuzz` with `{ teamId }`.
- Server sets `currentWinner` directly (ignores buzzMuted).
- Server broadcasts `winner` and `sessionState` to all.

### 4.6 Reset Buzz
- Host presses Enter key or clicks reset button → emits `resetBuzz`.
- Server clears `currentWinner` and `buzzStartedAt`, increments `session.round`.
- Server broadcasts `reset` and `sessionState` to all.
- Player BUZZ buttons re-enable.

### 4.6.1 Presence
- Server tracks connected player sockets per team (`session.players`).
- `sessionState.playersByTeam` exposes only counts, never socket ids.
- Host team boxes show a small "N 👤" badge so the MC can verify who is connected.

### 4.7 Score Control
- Only host can change scores.
- Keyboard shortcuts on host page:
  - A = +10, S = +20, D = +30
  - Z = -10, X = -20, C = -30
  - Enter = reset buzz
- Server validates host role, updates `session.scores[teamId]`.
- Server broadcasts updated `sessionState`.

### 4.8 Buzz Mute (Compulsory Questions)
- Host clicks the lock button → emits `toggleBuzzMute`.
- Server sets `session.buzzMuted`.
- Server broadcasts updated `sessionState`.
- When muted, player `buzz` events are rejected by the server (`reason:'muted'`), and player
  buttons show "LOCKED" instead of "BUZZ".
- Host `forceBuzz` still works regardless of mute state.
- Button/label state: **🔓 Buzz open** (players may buzz) or **🔒 Buzz locked**.

## 5. Socket.IO Events

### Client → Server
| Event | Payload | Role | Ack | Description |
|-------|---------|------|-----|-------------|
| join | { role, sessionId, key?, teamId? } | host/player | { ok, reason?, team?, session? } | Join a session room; host requires the key |
| buzz | {} | player | { ok, reason?, winner? } | Player requests to buzz |
| forceBuzz | { teamId } | host | — | Host manually selects a team (works when muted) |
| resetBuzz | {} | host | — | Clear current winner |
| changeScore | { teamId, amount } | host | — | Add/subtract score (|amount| ≤ 1000) |
| toggleBuzzMute | { muted } | host | — | Enable/disable player buzzing |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| sessionState | full public session snapshot | Full current state (no host key) |
| winner | { teamId, teamName, teamColor, ts, seq, source } | A team buzzed (`source`: player/host) |
| reset | { round } | Buzz state cleared |
| scoreChange | { teamId, amount, score } | Convenience echo for a score update |
| errorMessage | { text } | Error occurred (bad room, bad host key, …) |

## 6. Session Data Model

```js
{
  id: "ABC123",           // 6-char room code
  hostKey: "…",           // secret, only returned by POST /api/session
  title: "Quizware Session",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  teams: [
    { id: "1", name: "Team 1", color: "#ff9999" },
    ...
  ],
  scores: { "1": 0, "2": 0, ... },
  currentWinner: null | {
    teamId, teamName, teamColor, ts, seq, source
  },
  buzzStartedAt: null | timestamp,
  buzzMuted: false,
  buzzSeq: 0,             // monotonic winner counter
  round: 1,               // increments on every reset
  players: Map,           // socket.id -> { teamId, joinedAt } (not serialised)
  hostSockets: Set        // connected host socket ids (not serialised)
}
```

The public snapshot sent to clients contains everything above except `hostKey`, `players` and
`hostSockets`, plus `playersByTeam: { "1": 2, ... }` and `serverTime` (used by the host page to
correct clock skew when showing elapsed buzz time).

## 7. Cleanup Logic

- Every hour, a cleanup job runs.
- Any session older than 24 hours is deleted from the in-memory Map.
- Sessions do NOT survive server restart/reboot (in-memory only).
- To persist sessions across reboots, would need file/DB storage (future enhancement).

## 8. Nginx Configuration

```nginx
location = /quizware {
    return 301 /quizware/;
}

location /quizware/ {
    proxy_pass http://127.0.0.1:4000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

- Trailing slash on `proxy_pass` strips `/quizware/` prefix.
- All frontend URLs are relative, so they resolve correctly under the prefix
  (e.g. `api/session` → `/quizware/api/session`).
- The `Upgrade`/`Connection` headers are required for the WebSocket transport; without them
  Socket.IO falls back to HTTP polling and buzz latency/ordering gets noticeably worse.
- Prefer `127.0.0.1` over a LAN IP so the proxy survives DHCP changes.
- Cloudflare proxies `quizware.syss.hk` and provides analytics. A `502` from Cloudflare means
  Nginx is reachable but the Node process is not (see README troubleshooting).

## 9. Deployment

Three options, all detailed in `SELFHOST.md`:

- **Docker / Compose** (recommended): `Dockerfile` (Node 22 Alpine, non-root user, healthcheck on
  `/api/health`, production-only deps) plus `docker-compose.yml` (restart policy, read-only
  rootfs, `no-new-privileges`, port `4000`).
- **Bare metal**: `deploy/quizware.service` (systemd, hardened with `ProtectSystem=strict`) and
  `npm ci --omit=dev`.
- **Path prefix** `/quizware/`: `deploy/nginx-prefix.conf`; full domain: `deploy/nginx-quizware.syss.hk.conf`.

Runtime configuration:

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Listen port |
| `BIND` | `0.0.0.0` | Listen address |
| `MAX_SESSIONS` | `500` | Max live rooms (503 beyond) |
| `CREATE_LIMIT` | `20` | Rooms per IP per 10 minutes (429 beyond) |
| `TRUST_PROXY` | `0` | Set `1` behind Cloudflare/Nginx |

`GET /api/health` is the health probe used by Docker and CI.

## 9.1 systemd Auto-Start (bare metal)

File: `/etc/systemd/system/quizware.service` — copy from `deploy/quizware.service`.

```ini
[Unit]
Description=Quizware
After=network.target

[Service]
WorkingDirectory=/home/<user>/quizware
ExecStart=/usr/bin/npm start
Restart=always
User=<user>
Environment=NODE_ENV=production
Environment=PORT=4000

[Install]
WantedBy=multi-user.target
```

Enable with:
```bash
sudo systemctl daemon-reload
sudo systemctl enable quizware
sudo systemctl start quizware
```

## 10. Key Design Decisions

- **Host key**: `POST /api/session` returns a secret host key; only sockets presenting it may
  score/reset/force-buzz. Player QR codes carry the room and team only, so a player cannot
  hijack the MC screen by guessing the URL.
- **First arrival wins**: the winner is the first valid `buzz` event to reach the server. Phone
  clocks and client timestamps are never trusted (`seq` is monotonic, `ts` is server time).
- **Host-only buzz control**: Players can buzz, but host can also force-select any team. This gives MC full control.
- **Buzz mute**: For compulsory questions where buzzing is not needed, host can lock player buzz to avoid accidental clicks.
- **Beep on host only**: Sound plays on host page when a team buzzes, so MC hears it and can stop speaking.
- **No persistence**: Sessions are in-memory only; simple but means reboot loses all rooms.
- **Presence without identity**: only per-team counts are broadcast, no player names or socket ids.
- **Free for education**: Positioning is free for schools/educational use, mobile-first, no hardware dependency.

## 11. Future Enhancement Ideas

- Persistent session storage (JSON file or SQLite) to survive reboots.
- Customizable buzz sound / volume slider on the host page.
- Question display on host screen (question bank / slides).
- Countdown timer for answer time, auto-lock after N seconds.
- Team avatars/icons and per-team player names.
- Export results to CSV; undo last score change.
- Multi-language UI toggle (English / 繁體中文).
- Latency compensation using RTT measurement if millisecond fairness across poor Wi-Fi matters.
