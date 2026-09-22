'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Org } = require('../lib/org.js');
const { Auth } = require('../lib/auth.js');
const { Keys } = require('../lib/keys.js');
const { Telegram } = require('../lib/telegram.js');
const c = require('../lib/crypto.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const fakeClient = () => {
  const handlers = {};
  return { events: [], source: '127.0.0.1', on(name, fn) { handlers[name] = fn; }, emit(name, data) { if (name === 'close') return handlers.close?.(); this.events.push([name, data]); }, close() {} };
};

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-keys-'));
  const auth = new Auth(dir, quiet);
  const org = new Org({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const phone = c.generateKeyPair();
  const laptop = c.generateKeyPair();
  const ownerConn = org.bind(fakeClient(), owner, '127.0.0.1', phone.publicKey);
  const agentTok = auth.create({ name: 'a', role: 'agent' });
  const agentClient = fakeClient();
  const agentConn = org.bind(agentClient, auth.verify(agentTok.token), '127.0.0.1', laptop.publicKey);
  org.register(agentConn, { name: 'Alex', room: 'dev' });
  org.setStatus(agentConn, 'waiting', 'idle');
  return { dir, org, ownerConn, agentConn, agentClient, phone, laptop };
};

test('crypto: seal/unseal and room text round trip, wrong room fails', () => {
  const a = c.generateKeyPair();
  const rk = c.generateRoomKey();
  assert.strictEqual(c.unseal(c.seal(rk, a.publicKey), a.privateKey), rk);
  const ct = c.encryptText('hello', rk, 'dev');
  assert.ok(c.isSealed(ct));
  assert.strictEqual(c.decryptText(ct, rk, 'dev'), 'hello');
  assert.strictEqual(c.decryptText(ct, rk, 'ops'), null);
  assert.strictEqual(c.decryptText(ct, c.generateRoomKey(), 'dev'), null);
  assert.strictEqual(c.decryptText('plain', rk, 'dev'), 'plain');
});

test('keys: devices are remembered at sign-in and register, owner seals a room key for them', () => {
  const { org, phone, laptop, dir } = setup();
  const devices = org.keys.list('dev');
  assert.deepStrictEqual(devices.map((d) => d.name).sort(), ['Alex', 'bootstrap-owner', 'server']);
  assert.ok(devices.every((d) => d.sealed === false));
  assert.strictEqual(org.rooms().find((r) => r.room === 'dev').encrypted, false);
  // the phone (an owner device) makes a key and seals it to the laptop, not to the server
  const rk = c.generateRoomKey();
  const sealed = { [phone.publicKey]: c.seal(rk, phone.publicKey), [laptop.publicKey]: c.seal(rk, laptop.publicKey) };
  assert.deepStrictEqual(org.keys.put('dev', sealed), { room: 'dev', devices: 2 });
  assert.strictEqual(org.rooms().find((r) => r.room === 'dev').encrypted, true);
  assert.strictEqual(c.unseal(org.keys.sealedFor('dev', laptop.publicKey), laptop.privateKey), rk);
  assert.strictEqual(org.keys.sealedFor('dev', org.keys.serverPublicKey), null);
  assert.strictEqual(org.keys.roomKey('dev'), null, 'the server was not granted the room');
  // survives a restart
  const again = new Keys(dir, quiet);
  assert.strictEqual(again.serverPublicKey, org.keys.serverPublicKey);
  assert.ok(again.sealedFor('dev', phone.publicKey));
  assert.throws(() => org.keys.put('dev', { nope: { epk: 'x', iv: 'y', ct: 'z' } }), (e) => e.code === 400);
});

test('keys: the server opens a room only when granted; telegram shows [encrypted] otherwise', async () => {
  const { org, phone, agentConn, dir } = setup();
  const rk = c.generateRoomKey();
  org.keys.put('dev', { [phone.publicKey]: c.seal(rk, phone.publicKey) });
  const sent = [];
  const fetchImpl = async (url, { body }) => {
    const method = url.split('/').pop();
    if (method === 'sendMessage') sent.push(JSON.parse(body));
    return { ok: true, json: async () => ({ ok: true, result: method === 'getUpdates' ? [] : true }) };
  };
  const tg = new Telegram({ org, console: quiet, botToken: 't', dataDir: dir, fetchImpl, owner: 'misha' });
  tg.state.chats['-1'] = { room: 'dev' };
  tg.start();
  tg.stop();
  org.say(agentConn, 'dev', c.encryptText('secret plan', rk, 'dev'));
  await tg.queue;
  assert.strictEqual(sent.at(-1).text, 'Alex: [encrypted]');
  // owner typing into the group is refused, the room is encrypted and the server has no key
  await tg.onUpdate({ chat: { id: -1 }, from: { username: 'misha' }, text: 'hello' });
  await tg.queue;
  assert.match(sent.at(-1).text, /encrypted and the server was not granted/);
  // grant the server: now it relays in the clear both ways
  org.keys.put('dev', { [org.keys.serverPublicKey]: c.seal(rk, org.keys.serverPublicKey) });
  assert.strictEqual(org.keys.roomKey('dev'), rk);
  org.say(agentConn, 'dev', c.encryptText('tests pass', rk, 'dev'));
  await tg.queue;
  assert.strictEqual(sent.at(-1).text, 'Alex: tests pass');
  await tg.onUpdate({ chat: { id: -1 }, from: { username: 'misha' }, text: 'ship it' });
  const last = org.history(org.local('t'), 'dev', 1)[0];
  assert.ok(c.isSealed(last.text), 'what the group typed is stored sealed');
  assert.strictEqual(c.decryptText(last.text, rk, 'dev'), 'ship it');
});
