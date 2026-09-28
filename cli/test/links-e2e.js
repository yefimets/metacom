'use strict';
// Clicks in a message body, in the real chat: a person's name goes into the input, a web address
// is opened (here, with no browser, copied), a [file] token saves and opens the attachment.
//   node test/links-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');
const { connect } = require('../lib/client.js');

const port = 18900 + Math.floor(Math.random() * 1000);
const token = 'links-e2e-owner-' + Math.random().toString(36).slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-e2e-'));

const main = async () => {
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], { env: { ...process.env, HUB_PORT: String(port), HUB_DATA: dir, HUB_OWNER_TOKEN: token }, stdio: 'ignore' });
  await sleep(800);
  const url = `ws://127.0.0.1:${port}/`;
  const http = `http://127.0.0.1:${port}`;
  const agent = await connect({ url, token });
  await agent.api.agents.register({ name: 'opendev', room: 'opn', kind: 'agent' });
  const file = path.join(dir, 'notes.txt');
  fs.writeFileSync(file, 'hello\n');
  const { upload } = require('../lib/media.js');
  const media = await upload({ http, token, file });
  await agent.api.room.say({ room: 'opn', text: 'ask @opendev, or read https://example.com/docs/page and [notes.txt]', media: [media] });
  const chat = spawnChat({ room: 'opn', name: 'misha', cols: 100, rows: 20, env: { HOME: dir, MC_HUB_URL: url, MC_TOKEN: token, MC_MOUSE: '1', MC_CLICK_DEBUG: path.join(dir, 'clicks.log') } });
  const click = async (word) => {
    const rows = chat.view();
    const row = rows.findIndex((l) => l.includes(word) && l.includes('ask'));
    if (row < 0) throw new Error(`no line with ${word}:\n${chat.dump()}`);
    const col = rows[row].indexOf(word) + 2; // 1-based, inside the word
    await chat.type(`\x1b[<0;${col};${row + 1}M\x1b[<0;${col};${row + 1}m`, 700);
  };
  try {
    await chat.wait(/example\.com/, 8000);
    await click('example.com');
    const opened = /opened https:\/\/example\.com\/docs\/page|no browser here · https:\/\/example\.com\/docs\/page copied/;
    await chat.wait(opened, 8000);
    console.log('link  →', chat.view().find((l) => opened.test(l)).trim());
    await click('@opendev');
    await chat.wait(/❯ @opendev /, 3000);
    console.log('name  → input:', chat.view().find((l) => l.includes('❯')).trim());
    await click('notes.txt');
    await chat.wait(/(saved|opened) .*notes\.txt/, 5000);
    console.log('file  →', chat.view().find((l) => /(saved|opened) .*notes\.txt/.test(l)).trim());
    console.log('links e2e: ok');
  } catch (error) {
    console.log(chat.dump());
    throw error;
  } finally {
    agent.m.close();
    chat.kill();
    hub.kill();
  }
};

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  }
);
