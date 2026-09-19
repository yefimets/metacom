#!/bin/sh
# Runs the hub on this Mac at login, bound to localhost. Logs: ~/.local/share/metacom-hub/hub.log
set -e
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/dev.metacom.hub.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/share/metacom-hub"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.metacom.hub</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HUB_DIR/server.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>HUB_HOST</key><string>${HUB_HOST:-127.0.0.1}</string>
    <key>HUB_PORT</key><string>${HUB_PORT:-8900}</string>
    <key>OPENROUTER_API_KEY</key><string>${OPENROUTER_API_KEY:-}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.local/share/metacom-hub/hub.log</string>
  <key>StandardErrorPath</key><string>$HOME/.local/share/metacom-hub/hub.log</string>
</dict></plist>
PLIST
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "hub installed: $PLIST (HUB_HOST=${HUB_HOST:-127.0.0.1} HUB_PORT=${HUB_PORT:-8900})"
