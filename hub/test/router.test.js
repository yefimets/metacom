'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { heuristic } = require('../lib/router.js');

const members = [
  { name: 'Alex', kind: 'agent', connected: true, status: 'waiting', repo: '/Users/misha/flow', caps: ['swift', 'macos'], lastSeen: '2' },
  { name: 'Bob', kind: 'agent', connected: true, status: 'working', repo: '/srv/api', caps: ['node', 'metacom'], lastSeen: '1' },
  { name: 'Gone', kind: 'agent', connected: false, status: 'stopped', repo: '/x', caps: ['everything'], lastSeen: '3' },
  { name: 'Misha', kind: 'human', connected: true, status: 'waiting' },
];

test('router: name wins', () => {
  assert.strictEqual(heuristic('Bob, deploy the api', members).agent, 'Bob');
});

test('router: repository and capability', () => {
  assert.strictEqual(heuristic('fix the swift build in flow', members).agent, 'Alex');
  assert.strictEqual(heuristic('write a metacom unit', members).agent, 'Bob');
});

test('router: never picks offline agents or humans', () => {
  const pick = heuristic('do everything', members);
  assert.notStrictEqual(pick.agent, 'Gone');
  assert.notStrictEqual(pick.agent, 'Misha');
});

test('router: idle agent breaks a tie, and says so', () => {
  const pick = heuristic('hello there', members);
  assert.strictEqual(pick.agent, 'Alex');
  assert.strictEqual(pick.confident, false);
});

test('router: nobody connected', () => {
  assert.strictEqual(heuristic('x', [members[2]]), null);
});
