#!/usr/bin/env node
'use strict';
// Pulls termcn (https://termcn.dev) Ink components into src/ straight from the shadcn-format
// registry, resolving registry dependencies. Files are written verbatim, which the shadcn CLI
// does not always do (it turned a "\n" literal into "" in text-area.tsx).
//   node scripts/termcn-sync.js app-shell spinner theme-dracula …
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src');
const BASE = 'https://termcn.dev/r/ink/';
const TARGETS = { 'registry/ui/': 'components/ui/', 'registry/hooks/': 'hooks/', 'registry/lib/': 'lib/', 'registry/providers/': 'providers/', 'registry/themes/': 'lib/terminal-themes/' };

const wanted = process.argv.slice(2);
const seen = new Set();
const deps = new Set();

const fetchItem = async (name) => {
  const res = await fetch(BASE + name + '.json');
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
};

const target = (file) => {
  if (file.target) return file.target;
  for (const [from, to] of Object.entries(TARGETS)) if (file.path.startsWith(from)) return to + file.path.slice(from.length);
  throw new Error(`no target for ${file.path}`);
};

const sync = async (name) => {
  if (seen.has(name)) return;
  seen.add(name);
  const item = await fetchItem(name);
  for (const d of item.dependencies || []) deps.add(d);
  for (const file of item.files || []) {
    const out = path.join(ROOT, target(file));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, file.content);
    console.log(`${name.padEnd(24)} ${path.relative(process.cwd(), out)}`);
  }
  for (const url of item.registryDependencies || []) await sync(url.replace(BASE, '').replace(/\.json$/, ''));
};

(async () => {
  for (const name of wanted) await sync(name);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const missing = [...deps].filter((d) => !pkg.dependencies[d]);
  if (missing.length) console.log(`\nnpm install ${missing.join(' ')}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
