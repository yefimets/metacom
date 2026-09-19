'use strict';

const SIGNIN_TIMEOUT = 10_000;
const MAX_PER_IP = 64;
const BEFORE_SIGNIN = new Set(['auth/signin', 'system/introspect']);

/// Closes websocket connections that do not sign in: a socket has ten seconds to send an
/// `auth/signin` call, and until then the only other packet it may send is the
/// `system/introspect` the metacom client uses to scaffold its API.
const guardSockets = (wsServer, console) => {
  const perIp = new Map();
  wsServer.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const count = (perIp.get(ip) || 0) + 1;
    perIp.set(ip, count);
    if (count > MAX_PER_IP) {
      console.warn(`guard: ${ip} has ${count} sockets, refusing`);
      ws.terminate();
      return;
    }
    let signedIn = false;
    const timer = setTimeout(() => {
      if (signedIn) return;
      console.warn(`guard: ${ip} did not sign in within 10s, closing`);
      ws.terminate();
    }, SIGNIN_TIMEOUT);
    ws.on('message', (data) => {
      if (signedIn) return;
      let packet = null;
      try {
        packet = JSON.parse(data.toString());
      } catch {
        packet = null;
      }
      const method = packet && packet.type === 'call' ? packet.method : null;
      if (method === 'auth/signin') {
        signedIn = true;
        clearTimeout(timer);
        return;
      }
      if (BEFORE_SIGNIN.has(method)) return;
      console.warn(`guard: ${ip} sent ${method || 'junk'} before signing in, closing`);
      ws.terminate();
    });
    ws.on('close', () => {
      clearTimeout(timer);
      const left = (perIp.get(ip) || 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
  });
};

module.exports = { guardSockets };
