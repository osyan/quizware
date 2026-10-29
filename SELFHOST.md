# Self-hosting QuizWare

QuizWare is a single Node.js process with no database. Anything that can run a container (or
Node 18+) can host it: a school server, a VPS, a Raspberry Pi, or the laptop used at the event.

| Option | Good for | Effort |
|---|---|---|
| [Debian / Ubuntu script](#debian--ubuntu-server-step-by-step) | your VM or VPS, one command | 1 command |
| [Docker one-liner](#docker-one-liner) | quick trial, demo server | 1 command |
| [Docker Compose](#docker-compose) | permanent install, auto-restart | 2 commands |
| [Behind Nginx / Cloudflare](#behind-nginx--cloudflare-eg-quizwaresysshk) | public HTTPS demo | ~10 min |
| [LAN-only event](#lan-only-event-no-internet) | classroom with no internet | none |
| [Bare metal + systemd](#bare-metal-systemd) | Debian/Ubuntu VM without Docker | ~5 min |

## Debian / Ubuntu server (step by step)

This is the path for `quizware.syss.hk` (or any Debian 12 / Ubuntu 22.04+ box).

**1. Get the files onto the server** — either clone the repo:

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/osyan/quizware.git /opt/quizware
```

or copy your working folder from Windows with the built-in OpenSSH client:

```powershell
scp -r C:\Users\osyan\Desktop\OpencodeProjects\quiaware user@YOUR-SERVER:/opt/quizware
```

**2. Run the installer** (installs Docker if needed, builds the image, starts it, waits for health):

```bash
cd /opt/quizware
sudo bash deploy/install-debian.sh --domain quizware.syss.hk
```

Useful flags: `--port 8080` (host port), `--no-nginx` (leave Nginx alone),
`--skip-docker-install` (Docker already installed and you do not want the script touching it).

**3. DNS** — in Cloudflare, add an `A` record for `quizware.syss.hk` pointing at the server's IP,
proxied (orange cloud).

**4. HTTPS** — either turn on Cloudflare *SSL/TLS → Full*, or issue a certificate on the server:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d quizware.syss.hk
```

**5. Verify**:

```bash
curl -sS https://quizware.syss.hk/api/health     # {"ok":true,...}
sudo docker compose -f /opt/quizware/docker-compose.yml ps
```

Open the site, create a room, scan a QR from a phone on mobile data. If that works, the
WebSocket path through Nginx/Cloudflare is good.

**Updating later**:

```bash
cd /opt/quizware
sudo git pull
sudo docker compose up -d --build
```

**If it still returns 502**, the container is not up or Nginx points at the wrong port:

```bash
sudo docker ps -a
sudo docker compose -f /opt/quizware/docker-compose.yml logs --tail 50
ss -ltnp | grep 4000
```

The old config pointed at `192.168.88.123:4000`; the current vhost targets `127.0.0.1:4000`.

## Docker one-liner

```bash
docker run -d --name quizware -p 4000:4000 --restart unless-stopped \
  ghcr.io/osyan/quizware:latest
```

Open <http://localhost:4000> (or `http://<server-ip>:4000`).

The image is published to GitHub Container Registry when a `v*` tag is pushed (see
`.github/workflows/publish.yml`). GHCR packages are **private by default** — after the first
publish, open *Packages* on GitHub → the package → *Package settings* → *Change visibility* →
**Public**, otherwise `docker pull` asks for a login.

Supported platforms: `linux/amd64` and `linux/arm64` (Raspberry Pi 4/5, Apple Silicon).

## Docker Compose

```bash
git clone https://github.com/osyan/quizware.git
cd quizware
cp .env.example .env        # optional: change port / demo limits
docker compose up -d --build
docker compose logs -f
```

The compose file already sets `restart: unless-stopped`, a healthcheck on `/api/health`,
`read_only: true`, and `no-new-privileges`.

Stop / update:

```bash
docker compose down
git pull && docker compose up -d --build
```

Build the image yourself instead of pulling:

```bash
docker build -t quizware:local .
docker run -d -p 4000:4000 --restart unless-stopped quizware:local
```

## Behind Nginx / Cloudflare (e.g. quizware.syss.hk)

1. **Run the container** on the origin server (port 4000, bound to localhost is enough):

   ```bash
   docker run -d --name quizware -p 127.0.0.1:4000:4000 --restart unless-stopped \
     -e TRUST_PROXY=1 ghcr.io/osyan/quizware:latest
   ```

2. **Nginx site** — copy [`deploy/nginx-quizware.syss.hk.conf`](deploy/nginx-quizware.syss.hk.conf)
   to `/etc/nginx/sites-available/`, symlink into `sites-enabled`, `nginx -t`, reload.

3. **TLS** — either Cloudflare (proxied A record, *SSL/TLS* → *Full*) or certbot:

   ```bash
   sudo certbot --nginx -d quizware.syss.hk
   ```

4. **Cloudflare settings that matter**

   - WebSockets are enabled by default on all plans — leave them on; buzzing uses WSS.
   - Do **not** add a Cache Rule or "Cache Everything" for `quizware.syss.hk`; the API and
     Socket.IO handshake must not be cached.
   - `TRUST_PROXY=1` lets the room-creation rate limit see the visitor's real IP.

5. Visit `https://quizware.syss.hk`, create a room, and scan the QR from a phone (mobile data is
   fine — no same-Wi-Fi requirement when hosted publicly).

Path-prefix hosting (`https://syss.hk/quizware/`) is also supported: use
[`deploy/nginx-prefix.conf`](deploy/nginx-prefix.conf). Every URL in the app is relative, so no
rebuild is needed.

## LAN-only event (no internet)

Best for classrooms and venues with poor Wi-Fi:

1. Start QuizWare on the laptop connected to the projector (Docker or `npm start`).
2. Find the laptop's LAN IP, e.g. `192.168.1.20`.
3. Open `http://192.168.1.20:4000/config.html` **on that IP** (not `localhost`), so the QR codes
   point at the LAN address phones can reach.
4. Allow inbound TCP 4000 in the OS firewall (macOS/Windows will prompt on first run).
5. Players join the same Wi-Fi and scan.

Notes:

- Plain HTTP is fine: phones use the camera app to scan, and Socket.IO upgrades to `ws://` on the
  same origin. No certificate needed.
- Many school/guest Wi-Fi networks enable **client isolation** (AP isolation), which blocks
  phone → laptop traffic. If players cannot connect, that is the usual cause — use a dedicated
  router or ask IT to disable isolation.

## Bare metal (systemd)

```bash
sudo useradd --system --home /opt/quizware --shell /usr/sbin/nologin quizware
sudo git clone https://github.com/osyan/quizware.git /opt/quizware
cd /opt/quizware
sudo npm ci --omit=dev
sudo cp deploy/quizware.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quizware
```

Logs: `journalctl -u quizware -f`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Listen port |
| `BIND` | `0.0.0.0` | Listen address (`127.0.0.1` behind a proxy) |
| `MAX_SESSIONS` | `500` | Max live rooms; new rooms get HTTP 503 beyond this |
| `CREATE_LIMIT` | `20` | Rooms one IP may create per 10 minutes (HTTP 429) |
| `TRUST_PROXY` | `0` | Set `1` behind Cloudflare/Nginx so limits see real client IPs |

Rooms themselves expire 24 hours after creation (and immediately on restart).

## Limitations (by design)

- **In-memory only.** Restarting the container loses every room and score. Fine for a quiz night;
  not a records system. Export scores manually if you need them afterwards.
- **Single instance.** There is no shared state between replicas, so do not scale horizontally or
  put two containers behind a round-robin load balancer.
- **Host URL is the secret.** Anyone with `host.html?session=…&key=…` can change scores. Share the
  player link/QR, not the host link. Do not project the host browser's address bar.
- **No accounts.** Anyone who can reach the site can create a room. That is what makes it free and
  frictionless; the limits above keep a public demo from being trivially exhausted.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `502 Bad Gateway` from Nginx/Cloudflare | Container not running: `docker ps`, `docker logs quizware`, `curl -sS http://127.0.0.1:4000/api/health` |
| Buzz feels slow / "live" flickers | WebSocket blocked by a proxy. Add the `Upgrade`/`Connection` headers from the Nginx example (Socket.IO silently falls back to polling) |
| Phones cannot open the LAN URL | AP/client isolation on the Wi-Fi, or firewall blocking port 4000 |
| QR code points to `localhost` | You opened the config page via `localhost` on a LAN event — reopen it using the LAN IP |
| `429 rate-limited` while testing | Room-creation limit; wait 10 minutes or raise `CREATE_LIMIT` |
| Everything resets after deploy | Expected: sessions live in RAM |
