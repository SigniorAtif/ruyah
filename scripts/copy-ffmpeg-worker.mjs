// ffmpeg.wasm's worker loads its core with a runtime `import(url)`. Bundled, that
// import is rewritten into a module lookup and fails, so the worker is served
// as-is from public/ instead. Runs before dev and build; the copy is not committed.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules/@ffmpeg/ffmpeg/dist/esm');
const to = join(root, 'public/ffmpeg');
mkdirSync(to, { recursive: true });
for (const f of ['worker.js', 'const.js', 'errors.js']) copyFileSync(join(from, f), join(to, f));
