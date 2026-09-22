'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};
const MEDIA_DIR = path.join(os.homedir(), '.local', 'share', 'metacom', 'media');

const typeOf = (file) => TYPES[path.extname(file).toLowerCase()] || null;

/// `~/x.png` and quoted or escaped paths as a terminal pastes them (drag a file onto it).
const resolvePath = (raw) => {
  let p = String(raw || '').trim();
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) p = p.slice(1, -1);
  p = p.replace(/\\ /g, ' ');
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
};

/// A pasted line that is just a path to a file we can send, or null.
const attachable = (text) => {
  const t = String(text || '').trim();
  if (!t || t.includes('\n') || !/^(['"]?)(~\/|\/|\.\.?\/)/.test(t)) return null;
  const file = resolvePath(t);
  if (!typeOf(file)) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
};

const attachment = (file) => {
  const type = typeOf(file);
  if (!type) throw new Error(`${path.basename(file)}: only ${Object.keys(TYPES).join(' ')} can be sent`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file`);
  return { file, name: path.basename(file), type, size: stat.size };
};

const pretty = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/// POST the file to the mc; returns the media record to put on a message.
const upload = async ({ http, token, file }) => {
  const a = attachment(file);
  const res = await fetch(`${http}/media`, {
    method: 'POST',
    headers: { 'Content-Type': a.type, Authorization: `Bearer ${token}`, 'X-Name': encodeURIComponent(a.name) },
    body: fs.readFileSync(a.file),
  });
  if (!res.ok) {
    let reason = `${res.status}`;
    try {
      reason = (await res.json()).error || reason;
    } catch {
      // not json
    }
    throw new Error(`upload of ${a.name} failed: ${reason}`);
  }
  return res.json();
};

/// GET a message attachment into the local media cache; returns its path.
const download = async ({ http, url }) => {
  const m = /^\/media\/([0-9a-f]{32}\.[a-z0-9]{1,5})$/.exec(url || '');
  if (!m) throw new Error(`bad media url ${url}`);
  fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(MEDIA_DIR, m[1]);
  if (fs.existsSync(file)) return file;
  const res = await fetch(`${http}${url}`);
  if (!res.ok) throw new Error(`download of ${url} failed: ${res.status}`);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
};

/// The image on the clipboard as a png file, or null when there is none (or no tool for it).
/// macOS asks the clipboard through osascript; Linux tries wl-paste, then xclip.
const clipboardImage = () => {
  const out = path.join(os.tmpdir(), `metacom-paste-${Date.now()}.png`);
  const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 5000, ...opts });
  try {
    if (process.platform === 'darwin') {
      const script = `set p to POSIX file "${out}"\nset f to open for access p with write permission\ntry\nwrite (the clipboard as «class PNGf») to f\nend try\nclose access f`;
      run('osascript', ['-e', script]);
    } else if (process.env.WAYLAND_DISPLAY) {
      const types = run('wl-paste', ['--list-types']).toString();
      if (!types.includes('image/png')) return null;
      fs.writeFileSync(out, run('wl-paste', ['--type', 'image/png']));
    } else {
      fs.writeFileSync(out, run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']));
    }
  } catch {
    return null;
  }
  try {
    if (fs.statSync(out).size > 8) return out;
  } catch {
    // nothing written
  }
  try {
    fs.unlinkSync(out);
  } catch {
    // already gone
  }
  return null;
};

/// ` [shot.png 12 KB]` for message lines.
const describe = (media) => (Array.isArray(media) && media.length ? ' ' + media.map((m) => `[${m.name} ${pretty(m.size || 0)}]`).join(' ') : '');

module.exports = { TYPES, MEDIA_DIR, typeOf, resolvePath, attachable, attachment, upload, download, clipboardImage, describe, pretty };
