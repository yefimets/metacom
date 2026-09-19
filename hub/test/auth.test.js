'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Auth } = require('../lib/auth.js');

const quiet = { warn() {}, log() {} };

test('auth: bootstrap token, verify, revoke, hashes only on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-'));
  const auth = new Auth(dir, quiet);
  const boot = fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim();
  assert.strictEqual(auth.verify(boot).role, 'owner');
  const { token, record } = auth.create({ name: 'vps', role: 'agent' });
  assert.strictEqual(auth.verify(token).role, 'agent');
  assert.strictEqual(auth.verify('not-a-token-at-all-really'), null);
  const onDisk = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8');
  assert.ok(!onDisk.includes(token) && !onDisk.includes(boot));
  assert.strictEqual(auth.revoke(record.id), true);
  assert.strictEqual(auth.verify(token), null);
  assert.throws(() => auth.create({ name: 'x', role: 'root' }));
});

test('auth: five bad tokens block the address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-'));
  const auth = new Auth(dir, quiet);
  for (let i = 0; i < 5; i++) auth.recordFailure('10.0.0.1');
  assert.strictEqual(auth.blocked('10.0.0.1'), true);
  assert.strictEqual(auth.blocked('10.0.0.2'), false);
});
