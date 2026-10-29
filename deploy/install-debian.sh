#!/usr/bin/env bash
#
# QuizWare installer for Debian/Ubuntu servers.
# Installs Docker if missing, builds the image, starts the container,
# waits for the health check and (optionally) installs the Nginx vhost.
#
# Usage:
#   sudo bash deploy/install-debian.sh                      # plain install on port 4000
#   sudo bash deploy/install-debian.sh --domain quizware.syss.hk
#   sudo bash deploy/install-debian.sh --port 8080 --image ghcr.io/OWNER/quizware:latest
#
set -euo pipefail

cd "$(dirname "$0")/.."

DOMAIN=""
PORT="4000"
IMAGE=""          # when set, pull the prebuilt image instead of building
SERVICE_NAME="quizware"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --port)   PORT="$2";   shift 2 ;;
    --image)  IMAGE="$2";  shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo (needs docker and, optionally, nginx)." >&2
  exit 1
fi

echo "==> Installing Docker if needed"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

echo "==> Starting ${IMAGE:+from image $IMAGE}"
if [[ -n "$IMAGE" ]]; then
  docker pull "$IMAGE"
  docker rm -f "$SERVICE_NAME" 2>/dev/null || true
  docker run -d --name "$SERVICE_NAME" \
    -p "127.0.0.1:${PORT}:4000" \
    --restart unless-stopped \
    -e TRUST_PROXY="${TRUST_PROXY:-1}" \
    "$IMAGE"
else
  docker rm -f "$SERVICE_NAME" 2>/dev/null || true
  docker compose up -d --build
  # Publish on localhost only; Nginx fronts it.
  if ! docker port "$SERVICE_NAME" "4000" >/dev/null 2>&1; then
    echo "   (compose published on 0.0.0.0; fine for LAN mode)"
  fi
fi

echo "==> Waiting for health check"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "    healthy ✔"
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || {
  echo "Health check FAILED after 30s — inspect with: docker logs --tail 100 ${SERVICE_NAME}" >&2
  exit 1
}

if [[ -n "$DOMAIN" ]]; then
  echo "==> Installing Nginx vhost for https://${DOMAIN}"
  if ! command -v nginx >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
  fi
  cp deploy/nginx-proxy.inc /etc/nginx/quizware_proxy.inc
  sed "s/quizware.syss.hk/${DOMAIN}/g; s/listen 443 ssl;/listen 80; # run certbot --nginx to add TLS/" \
    deploy/nginx-quizware.syss.hk.conf > "/etc/nginx/sites-available/${DOMAIN}.conf"
  ln -sf "/etc/nginx/sites-available/${DOMAIN}.conf" "/etc/nginx/sites-enabled/${DOMAIN}.conf"
  nginx -t
  systemctl reload nginx
  echo "==> Obtaining certificate (interactive):"
  echo "    certbot --nginx -d ${DOMAIN}"
fi

echo
echo "QuizWare is running on http://127.0.0.1:${PORT}"
echo "Logs:   docker logs -f ${SERVICE_NAME}"
