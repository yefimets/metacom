'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail } = require('./errors.js');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PER_MESSAGE = 8;
const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
};
const EXTS = Object.fromEntries(Object.entries(TYPES).map(([type, ext]) => [ext, type]));
const FILE = /^\/media\/([0-9a-f]{32})\.([a-z0-9]{1,5})$/;

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

const safeName = (value) => String(value || '').replace(/[^\w.() -]/g, '_').slice(0, 120) || 'file';

/// Files attached to messages: images pasted into the phone or terminal chat, and reports
/// agents send back.
/// Stored under <data>/media/<id>.<ext> with a random id; the id is the only thing that
/// grants a read, so an agent on another machine can fetch it with a plain GET.
class Media {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'media');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(buffer, type, name) {
    const ext = TYPES[type];
    if (!ext) throw fail(415, `unsupported type ${type}; one of ${Object.keys(TYPES).join(', ')}`);
    if (buffer.length === 0) throw fail(400, 'empty file');
    if (buffer.length > MAX_BYTES) throw fail(413, `file is larger than ${MAX_BYTES / 1024 / 1024} MB`);
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(this.dir, `${id}.${ext}`), buffer, { mode: 0o600 });
    return { url: `/media/${id}.${ext}`, type, size: buffer.length, name: safeName(name || `${id.slice(0, 8)}.${ext}`) };
  }

  /// The stored file behind a /media url, or null.
  file(url) {
    const m = FILE.exec(String(url || ''));
    if (!m || !EXTS[m[2]]) return null;
    const file = path.join(this.dir, `${m[1]}.${m[2]}`);
    return fs.existsSync(file) ? { file, type: EXTS[m[2]] } : null;
  }

  /// The `media` field of a message as the hub stores it: a short list of known files.
  attachments(list) {
    if (list === undefined || list === null) return null;
    if (!Array.isArray(list)) throw fail(400, 'media must be a list');
    if (list.length > MAX_PER_MESSAGE) throw fail(400, `at most ${MAX_PER_MESSAGE} files per message`);
    const out = [];
    for (const item of list) {
      const url = item && typeof item === 'object' ? item.url : item;
      const stored = this.file(url);
      if (!stored) throw fail(400, `unknown media ${url}`);
      const size = Number(item.size) || fs.statSync(stored.file).size;
      out.push({ url, type: stored.type, size, name: safeName(item.name) });
    }
    return out.length ? out : null;
  }
}

/// POST /media (Authorization: Bearer <token>, Content-Type, X-Name) stores a file and
/// answers with its {url, type, size, name}; GET /media/<id>.<ext> serves it.
const serveMedia = (httpServer, { media, auth, console }) => {
  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  httpServer.on('request', (req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname !== '/media' && !pathname.startsWith('/media/')) return;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const stored = media.file(pathname);
      if (!stored) return send(res, 404, { error: 'not found' });
      const data = fs.readFileSync(stored.file);
      res.writeHead(200, { ...SECURITY, 'Content-Type': stored.type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
      res.end(req.method === 'HEAD' ? undefined : data);
      return;
    }
    if (req.method !== 'POST' || pathname !== '/media') return send(res, 405, { error: 'method not allowed' });
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const record = token ? auth.verify(token) : null;
    if (!record) return send(res, 401, { error: 'bad token' });
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!TYPES[type]) return send(res, 415, { error: `unsupported type ${type || '(none)'}` });
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        send(res, 413, { error: `file is larger than ${MAX_BYTES / 1024 / 1024} MB` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const name = decodeURIComponent(String(req.headers['x-name'] || ''));
        const saved = media.save(Buffer.concat(chunks), type, name);
        console.log(`media: ${record.name} uploaded ${saved.name} (${saved.size} bytes)`);
        send(res, 200, saved);
      } catch (error) {
        send(res, error.code || 500, { error: error.message });
      }
    });
  });
};

module.exports = { Media, serveMedia, TYPES, MAX_BYTES };
