'use strict';
// A room call end to end, with no sound card: a hub of its own on a spare port, two chats,
// ann's "mic" a tone generator, bob's "speaker" a file. ann joins with /voice, bob by clicking
// his own name; bob must see ann's bars move and receive her audio.
//   node test/voice-e2e.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnChat, sleep } = require('./tui-driver.js');

const port = 18900 + Math.floor(Math.random() * 1000);
const token = 'voice-e2e-owner-' + Math.random().toString(36).slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-e2e-'));
const heard = path.join(dir, 'bob-heard.raw');
// 40 ms frames as a recorder would stream them: a square wave in "words" of 200 ms with 80 ms
// pauses. A steady tone would not do: the gate takes anything without gaps for background noise.
const tone = `node -e "const b=Buffer.alloc(1280),z=Buffer.alloc(1280);for(let i=0;i<1280;i+=2)b.writeInt16LE(i%8<4?8000:-8000,i);let n=0;setInterval(()=>process.stdout.write(n++%7<5?b:z),40)"`;

const main = async () => {
  const hub = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hub', 'server.js')], {
    env: { ...process.env, HUB_PORT: String(port), HUB_DATA: dir, HUB_OWNER_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  hub.stdout.on('data', (d) => (log += d));
  hub.stderr.on('data', (d) => (log += d));
  await sleep(800);
  // HOME: an empty one, so the chats use this hub's token and not the one `metacom login` saved
  const env = { HOME: dir, MC_HUB_URL: `ws://127.0.0.1:${port}/`, MC_TOKEN: token, MC_MOUSE: '1' };
  const a = spawnChat({ room: 'call', name: 'ann', cols: 80, rows: 16, env: { ...env, MC_VOICE_REC: tone, MC_VOICE_PLAY: `cat > ${path.join(dir, 'ann-heard.raw')}` } });
  const b = spawnChat({ room: 'call', name: 'bob', cols: 80, rows: 16, env: { ...env, MC_VOICE_REC: 'sleep 60', MC_VOICE_PLAY: `cat > ${heard}` } });
  const show = (c, title) => console.log(`\n=== ${title} ===\n${c.dump().replace(/\n+$/, '')}\n`);
  try {
    await a.wait(/@ for agents/, 8000);
    await b.wait(/@ for agents/, 8000);
    await a.type('/voice');
    await a.type(a.key.enter, 300);
    await b.wait(/ann joined the call/);
    // ann talks: bob's line shows her bars moving (a block other than the flat ▁)
    await b.wait(/ann [▂▃▄▅▆▇]{2}/);
    show(b, 'bob: ann is talking');
    // bob clicks his own name on the status line (the row above the input box)
    const rows = b.view();
    const row = rows.findIndex((l) => / bob · call/.test(l));
    const col = rows[row].indexOf('bob · call') + 1;
    await b.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`, 400);
    await b.wait(/▁▁ bob · call/);
    show(b, 'bob: joined by clicking his name');
    await sleep(1500);
    const bytes = fs.existsSync(heard) ? fs.statSync(heard).size : 0;
    console.log(`bob's speaker got ${bytes} bytes of ann`);
    if (bytes < 16_000) throw new Error('bob heard (almost) nothing');
    await a.type('/mute');
    await a.type(a.key.enter, 800);
    await b.wait(/ann ▁▁/);
    show(a, 'ann: muted');
    await b.type('/voice off');
    await b.type(b.key.enter, 300);
    await a.wait(/bob left the call/);
    console.log('voice e2e: ok');
  } catch (error) {
    show(a, 'ann');
    show(b, 'bob');
    console.log(log.split('\n').slice(-20).join('\n'));
    throw error;
  } finally {
    a.kill();
    b.kill();
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
