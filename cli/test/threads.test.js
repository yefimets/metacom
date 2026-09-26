'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Threads, transcriptExists } = require('../lib/threads.js');

const setup = (cwd = '/work/app') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-'));
  const make = () => new Threads({ name: 'metadev', cwd, dir });
  return { dir, make };
};
// what Claude Code's SessionStart hook appends
const hook = (t, id, source) => fs.appendFileSync(t.hookFile, JSON.stringify({ session_id: id, source, transcript_path: '/x', cwd: '/work/app', hook_event_name: 'SessionStart' }) + '\n');
const cmd = (id, thread, replyTo = null) => ({ id, kind: 'command', thread, replyTo, from: { name: 'misha' }, text: 't' });

test('threads: a fresh agent types the first command where it is; the next plain one clears first', () => {
  const { make } = setup();
  const t = make();
  hook(t, 'S1', 'startup');
  t.poll();
  assert.deepStrictEqual(t.plan(cmd('m1', 'm1')), { action: 'type' }, 'nothing to clear yet');
  t.typed(cmd('m1', 'm1'));
  assert.deepStrictEqual(t.plan(cmd('m2', 'm2')), { action: 'clear' }, 'a new thread gets a clean context');
  hook(t, 'S2', 'clear');
  t.poll();
  assert.deepStrictEqual(t.plan(cmd('m2', 'm2')), { action: 'type' }, 'after /clear it is typed');
  t.typed(cmd('m2', 'm2'));
  assert.deepStrictEqual(t.byThread, { m1: 'S1', m2: 'S2' });
});

test('threads: a reply goes back to its thread\'s conversation, or stays when it is already open', () => {
  const { make } = setup();
  const t = make();
  hook(t, 'S1', 'startup');
  t.poll();
  t.typed(cmd('m1', 'm1'));
  hook(t, 'S2', 'clear');
  t.poll();
  t.typed(cmd('m2', 'm2'));
  assert.deepStrictEqual(t.plan(cmd('m3', 'm1', 'a1')), { action: 'resume', sid: 'S1' });
  hook(t, 'S1', 'resume');
  t.poll();
  assert.strictEqual(t.used, true, 'a resumed conversation has its history');
  assert.deepStrictEqual(t.plan(cmd('m3', 'm1', 'a1')), { action: 'type' });
  assert.deepStrictEqual(t.plan(cmd('m4', 'unknown', 'x')), { action: 'type' }, 'a thread it never saw: carry on where it is');
  assert.deepStrictEqual(t.plan({ ...cmd('n1', 'm2'), kind: 'info' }), { action: 'type' }, 'notes never switch');
});

test('threads: the map outlives the wrapper, but not a move to another folder', async () => {
  const { dir, make } = setup('/work/app');
  const t = make();
  hook(t, 'S1', 'startup');
  t.poll();
  t.typed(cmd('m1', 'm1'));
  t.close();
  const again = make();
  assert.strictEqual(again.last, 'S1', 'a restarted agent resumes its last conversation');
  assert.deepStrictEqual(again.byThread, { m1: 'S1' });
  const elsewhere = new Threads({ name: 'metadev', cwd: '/work/other', dir });
  assert.strictEqual(elsewhere.last, null);
  assert.deepStrictEqual(elsewhere.byThread, {});
  const waiting = again.next(1000);
  hook(again, 'S9', 'clear');
  again.poll();
  assert.strictEqual(await waiting, 'S9', 'next() hears the session /clear opened');
});

test('threads: a half-written hook line is read once it is whole', () => {
  const { make } = setup();
  const t = make();
  const line = JSON.stringify({ session_id: 'S1', source: 'startup' });
  fs.appendFileSync(t.hookFile, line.slice(0, 10));
  assert.deepStrictEqual(t.poll(), []);
  fs.appendFileSync(t.hookFile, line.slice(10) + '\n');
  assert.deepStrictEqual(t.poll(), [{ id: 'S1', source: 'startup' }]);
  assert.strictEqual(t.current, 'S1');
});

test('threads: transcriptExists follows Claude Code\'s folder naming', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const folder = path.join(home, '.claude', 'projects', '-home-misha-metacom--claude-worktrees-x');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'S1.jsonl'), '');
  assert.strictEqual(transcriptExists('/home/misha/metacom/.claude/worktrees/x', 'S1', home), true);
  assert.strictEqual(transcriptExists('/home/misha/metacom/.claude/worktrees/x', 'S2', home), false);
});
