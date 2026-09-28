'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// a room name as the hub takes it, as the whole path: /opn, /dev
const ROOM_PATH = /^\/[\w][\w.-]{0,63}$/;

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'",
};

/// Serves the phone web client from the same port as the API. metacom's own handler only
/// answers /api paths and leaves everything else untouched, so this second listener
/// completes those requests.
const serveWeb = (httpServer, dir) => {
  httpServer.on('request', (req, res) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/media')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY).end();
      return;
    }
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    if (pathname === '/health') {
      res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES['.json'] });
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
      return;
    }
    // the terminal-style client lived at /tui/ before it became the page: old links land on it
    if (pathname === '/tui' || pathname.startsWith('/tui/')) {
      res.writeHead(301, { ...SECURITY, Location: '/' }).end();
      return;
    }
    // a folder is its index.html; /name goes to /name/
    if (/^\/[a-z]+$/.test(pathname) && fs.existsSync(path.join(dir, pathname.slice(1), 'index.html'))) {
      res.writeHead(301, { ...SECURITY, Location: pathname + '/' }).end();
      return;
    }
    const rel = pathname === '/' ? 'index.html' : pathname.endsWith('/') ? pathname.slice(1) + 'index.html' : pathname.slice(1);
    let file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep) && file !== path.resolve(dir, 'index.html')) {
      res.writeHead(403, SECURITY).end();
      return;
    }
    fs.readFile(file, (error, data) => {
      // /opn, /dev: a room's own address is the page, which opens that room
      // (a missing file keeps its 404: a room is never named like app.js or logo.png)
      const asset = TYPES[path.extname(pathname).toLowerCase()] || /\.(ico|map|txt|jpe?g|gif|webp|woff|ttf)$/i.test(pathname);
      if (error && ROOM_PATH.test(pathname) && !asset) {
        file = path.resolve(dir, 'index.html');
        return fs.readFile(file, (e2, page) => {
          if (e2) return void res.writeHead(404, SECURITY).end();
          res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES['.html'], 'Content-Length': page.length });
          res.end(req.method === 'HEAD' ? undefined : page);
        });
      }
      if (error) {
        res.writeHead(404, SECURITY).end();
        return;
      }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
};

module.exports = { serveWeb };
