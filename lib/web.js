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
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
};

/// Serves the phone web client from the same port as the API. metacom's own handler only
/// answers /api paths and leaves everything else untouched, so this second listener
/// completes those requests.
const serveWeb = (httpServer, dir) => {
  httpServer.on('request', (req, res) => {
    if (req.url.startsWith('/api')) return;
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
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep) && file !== path.resolve(dir, 'index.html')) {
      res.writeHead(403, SECURITY).end();
      return;
    }
    fs.readFile(file, (error, data) => {
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
