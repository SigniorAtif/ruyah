// Checks the built bundle in out/ for the dev tools (lib/devTools.d.ts).
//
//   node scripts/check-dev-tools.mjs absent    after `npm run build`
//   node scripts/check-dev-tools.mjs present   after `RUYAH_DEV_TOOLS=1 npm run build`
//
// `absent` is the release gate. `present` keeps the gate honest: if a marker
// below stops appearing in a build that does have the tools (renamed text, a
// moved file), `absent` would pass for the wrong reason, so this fails first.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Strings that only the dev-tools modules contain, one per module.
const MARKERS = [
  'network simulation', // components/dev/NetworkPanel.tsx
  'waiting out your lead', // components/dev/SyncIndicator.tsx
  '"instruments"', // components/dev/InstrumentsPanel.tsx
  'pendingReceives', // lib/sync/simulatedTransport.ts
  'BroadcastChannel', // lib/sync/mockTransport.ts
  '__ruyah', // PlayerEngine's console handle
];

const mode = process.argv[2];
if (mode !== 'absent' && mode !== 'present') {
  console.error('usage: node scripts/check-dev-tools.mjs absent|present');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'out', '_next');

function* files(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (p.endsWith('.js')) yield p;
  }
}

const found = new Map(MARKERS.map((m) => [m, []]));
for (const f of files(dir)) {
  const text = readFileSync(f, 'utf8');
  for (const m of MARKERS) if (text.includes(m)) found.get(m).push(relative(root, f));
}

let failed = false;
for (const [m, where] of found) {
  if (mode === 'absent' && where.length) {
    console.error(`dev tools in the bundle: "${m}" in ${where.join(', ')}`);
    failed = true;
  }
  if (mode === 'present' && !where.length) {
    console.error(`"${m}" is missing from a build with dev tools; update MARKERS`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(mode === 'absent' ? 'Clean: no dev tools in the bundle.' : 'All dev-tools markers found.');
