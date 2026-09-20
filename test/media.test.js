'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');
const { Media, serveMedia } = require('../lib/media.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const fakeClient = () => {
  const handlers = {};
  return { events: [], source: '127.0.0.1', on(name, fn) { handlers[name] = fn; }, emit(name, data) { if (name === 'close') return handlers.close?.(); this.events.push([name, data]); }, close() {} };
};

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const ownerToken = fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim();
  const ownerConn = hub.bind(fakeClient(), auth.verify(ownerToken), '127.0.0.1');
  const agentClient = fakeClient();
  const agentConn = hub.bind(agentClient, auth.verify(auth.create({ name: 'a', role: 'agent' }).token), '127.0.0.1');
  hub.register(agentConn, { name: 'Alex', room: 'dev' });
  return { dir, auth, hub, ownerToken, ownerConn, agentConn, agentClient };
};

test('media: stored files ride on messages, unknown ones are refused', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  const saved = hub.media.save(PNG, 'image/png', 'shot.png');
  assert.match(saved.url, /^\/media\/[0-9a-f]{32}\.png$/);
  assert.ok(hub.media.file(saved.url));
  const said = hub.say(ownerConn, 'dev', '', [saved]);
  assert.strictEqual(said.text, '');
  assert.deepStrictEqual(said.media, [{ url: saved.url, type: 'image/png', size: PNG.length, name: 'shot.png' }]);
  hub.setStatus(agentConn, 'waiting', 'idle');
  await hub.send(ownerConn, 'Alex', 'look', 'command', null, [{ url: saved.url, name: 'a b.png' }]);
  const delivered = agentClient.events.find(([n]) => n === 'agents/message')[1];
  assert.strictEqual(delivered.media[0].name, 'a b.png');
  assert.throws(() => hub.say(ownerConn, 'dev', 'x', [{ url: '/media/' + '0'.repeat(32) + '.png' }]), (e) => e.code === 400);
  assert.throws(() => hub.say(ownerConn, 'dev', '', []), (e) => e.code === 400);
  assert.throws(() => hub.media.save(PNG, 'application/zip', 'x.zip'), (e) => e.code === 415);
});

test('media: POST /media needs a token and answers with the url, GET serves the bytes', async () => {
  const { dir, auth, ownerToken } = setup();
  const media = new Media(dir);
  const server = http.createServer();
  serveMedia(server, { media, auth, console: quiet });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/media`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
    assert.strictEqual(denied.status, 401);
    const bad = await fetch(`${base}/media`, { method: 'POST', headers: { 'Content-Type': 'application/zip', Authorization: `Bearer ${ownerToken}` }, body: PNG });
    assert.strictEqual(bad.status, 415);
    const ok = await fetch(`${base}/media`, { method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${ownerToken}`, 'X-Name': 'shot.png' }, body: PNG });
    assert.strictEqual(ok.status, 200);
    const saved = await ok.json();
    assert.strictEqual(saved.name, 'shot.png');
    assert.strictEqual(saved.size, PNG.length);
    const got = await fetch(base + saved.url);
    assert.strictEqual(got.headers.get('content-type'), 'image/png');
    assert.deepStrictEqual(Buffer.from(await got.arrayBuffer()), PNG);
    assert.strictEqual((await fetch(`${base}/media/${'0'.repeat(32)}.png`)).status, 404);
  } finally {
    server.close();
  }
});
