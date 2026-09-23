#!/bin/sh
# One-shot install of metacom on a fresh Linux VM (Debian/Ubuntu), run from your machine:
#   deploy/remote-install.sh root@HOST mc.example.com
# Copies this checkout, installs Docker if missing, starts metacom + Caddy (TLS), prints the
# owner token once, and opens ports 22/80/443 only.
set -e
TARGET="$1"; DOMAIN="$2"
[ -n "$TARGET" ] && [ -n "$DOMAIN" ] || { echo "usage: $0 user@host mc.domain"; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ copying sources"
ssh "$TARGET" 'mkdir -p ~/metacom'
tar -C "$ROOT" --exclude node_modules --exclude '.git' -czf - . | ssh "$TARGET" 'tar -C ~/metacom -xzf -'

echo "→ installing docker and starting metacom"
ssh "$TARGET" "DOMAIN='$DOMAIN' sh -s" <<'REMOTE'
set -e
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi
cd ~/metacom/deploy
printf 'MC_DOMAIN=%s\n' "$DOMAIN" > .env
chmod 600 .env
docker compose up -d --build >/dev/null
sleep 3
docker compose ps --format '{{.Name}} {{.Status}}'
echo "--- owner token (shown once) ---"
docker compose exec -T metacom cat /data/bootstrap-token.txt
docker compose exec -T metacom rm -f /data/bootstrap-token.txt
REMOTE
echo "→ done. Point DNS: $DOMAIN A <VM IP>, then on the Mac: metacom login wss://$DOMAIN/ <token>"
