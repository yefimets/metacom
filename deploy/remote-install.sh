#!/bin/sh
# One-shot install of the org on a fresh Linux VM (Debian/Ubuntu), run from the Mac:
#   org/deploy/remote-install.sh root@HOST org.metacom.dev
# Copies metacom/ and org/, installs Docker if missing, starts org + Caddy (TLS), prints the
# owner token once, and opens ports 22/80/443 only.
set -e
TARGET="$1"; DOMAIN="$2"
[ -n "$TARGET" ] && [ -n "$DOMAIN" ] || { echo "usage: $0 user@host org.domain"; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# OPENROUTER_API_KEY and TELEGRAM_* lines of ~/.config/metacom/metacom.env travel to the server's .env
KEY_LINE=""
[ -f "$HOME/.config/metacom/metacom.env" ] && KEY_LINE="$(grep -E '^(OPENROUTER_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_OWNER)=' "$HOME/.config/metacom/metacom.env" || true)"

echo "→ copying sources"
ssh "$TARGET" 'mkdir -p ~/metacom'
tar -C "$ROOT" --exclude node_modules --exclude '.git' -czf - metacom org | ssh "$TARGET" 'tar -C ~/metacom -xzf -'

echo "→ installing docker and starting the org"
ssh "$TARGET" "DOMAIN='$DOMAIN' KEY_LINE='$KEY_LINE' sh -s" <<'REMOTE'
set -e
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi
cd ~/metacom/org/deploy
printf 'MC_DOMAIN=%s\n%s\n' "$DOMAIN" "${KEY_LINE:-OPENROUTER_API_KEY=}" > .env
chmod 600 .env
docker compose up -d --build >/dev/null
sleep 3
docker compose ps --format '{{.Name}} {{.Status}}'
echo "--- owner token (shown once) ---"
docker compose exec -T org cat /data/bootstrap-token.txt
docker compose exec -T org rm -f /data/bootstrap-token.txt
REMOTE
echo "→ done. Point DNS: $DOMAIN A <VM IP>, then on the Mac: metacom login wss://$DOMAIN/ <token>"
