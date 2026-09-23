'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Org } = require('../lib/org.js');
const { Auth } = require('../lib/auth.js');
const { Keys } = require('../lib/keys.js');
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

test('keys: the server opens a room only when granted, and seals what it writes', () => {
  const { org, phone, agentConn } = setup();
  const rk = c.generateRoomKey();
  org.keys.put('dev', { [phone.publicKey]: c.seal(rk, phone.publicKey) });
  // not granted: the server cannot read the room, and refuses to write into it
  org.say(agentConn, 'dev', c.encryptText('secret plan', rk, 'dev'));
  const stored = org.history(org.local('t'), 'dev', 1)[0];
  assert.ok(c.isSealed(stored.text));
  assert.strictEqual(org.keys.open('dev', stored.text), null);
  assert.throws(() => org.keys.close('dev', 'from the server'), (e) => e.code === 403);
  // granted: it opens and seals like any other device
  org.keys.put('dev', { [org.keys.serverPublicKey]: c.seal(rk, org.keys.serverPublicKey) });
  assert.strictEqual(org.keys.roomKey('dev'), rk);
  assert.strictEqual(org.keys.open('dev', stored.text), 'secret plan');
  const sealed = org.keys.close('dev', 'from the server');
  assert.ok(c.isSealed(sealed));
  assert.strictEqual(c.decryptText(sealed, rk, 'dev'), 'from the server');
  // a plain room passes text through untouched
  assert.strictEqual(org.keys.close('other', 'plain'), 'plain');
  assert.strictEqual(org.keys.open('other', 'plain'), 'plain');
});
