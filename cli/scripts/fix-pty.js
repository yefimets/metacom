'use strict';
// npm drops the execute bit on node-pty's spawn-helper on some setups; posix_spawnp then fails.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const platform of fs.readdirSync(dir)) {
    const helper = path.join(dir, platform, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch {
  // no prebuilds, nothing to fix
}
