#!/bin/sh
# Runs metacom on this Mac at login, bound to localhost. Logs: ~/.local/share/metacom/metacom.log
set -e
MC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/dev.metacom.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/share/metacom"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.metacom</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$MC_DIR/server.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>MC_HOST</key><string>${MC_HOST:-127.0.0.1}</string>
    <key>MC_PORT</key><string>${MC_PORT:-8900}</string>
    <key>OPENROUTER_API_KEY</key><string>${OPENROUTER_API_KEY:-}</string>
    <key>TELEGRAM_BOT_TOKEN</key><string>${TELEGRAM_BOT_TOKEN:-}</string>
    <key>TELEGRAM_OWNER</key><string>${TELEGRAM_OWNER:-}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.local/share/metacom/metacom.log</string>
  <key>StandardErrorPath</key><string>$HOME/.local/share/metacom/metacom.log</string>
</dict></plist>
PLIST
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "metacom installed: $PLIST (MC_HOST=${MC_HOST:-127.0.0.1} MC_PORT=${MC_PORT:-8900})"
