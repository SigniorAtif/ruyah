/**
 * Keeps what ffmpeg pulled out of a film (an audio track, the subtitle text)
 * between sessions, so the second watch starts instantly instead of reading
 * the whole file again.
 *
 * Stored in the origin-private file system: on this machine, invisible to the
 * page's other origins, and never uploaded. Entries are keyed by the file's
 * name, size and modification time, which is what identifies "the same file"
 * without reading it. The least recently used entries go once the total
 * passes the cap.
 */

/** Room for a handful of films' worth of audio. */
const CAP_BYTES = 1.5 * 1024 ** 3;
const USE_KEY = 'ruyah:extract-cache-used';

type Dir = FileSystemDirectoryHandle;

let dirPromise: Promise<Dir | null> | null = null;

function cacheDir(): Promise<Dir | null> {
  dirPromise ??= (async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle('extracted', { create: true });
    } catch {
      return null;
    }
  })();
  return dirPromise;
}

async function fileKey(file: File): Promise<string> {
  const id = new TextEncoder().encode(`${file.name}\0${file.size}\0${file.lastModified}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', id));
  return Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

function readUse(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USE_KEY) || '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function touch(name: string, remove = false): void {
  const use = readUse();
  if (remove) delete use[name];
  else use[name] = Date.now();
  try {
    localStorage.setItem(USE_KEY, JSON.stringify(use));
  } catch {
    // The cache still works; eviction just falls back to oldest-first by name.
  }
}

/** What was cached for this file under `slot` (e.g. "audio-3.m4a"), or null. */
export async function getCached(file: File, slot: string, type: string): Promise<Blob | null> {
  const dir = await cacheDir();
  if (!dir) return null;
  const name = `${await fileKey(file)}-${slot}`;
  try {
    const handle = await dir.getFileHandle(name);
    const stored = await handle.getFile();
    if (stored.size === 0) return null;
    touch(name);
    // OPFS files come back untyped; the media element wants to know.
    return new Blob([stored], { type });
  } catch {
    return null;
  }
}

export async function putCached(file: File, slot: string, blob: Blob): Promise<void> {
  const dir = await cacheDir();
  if (!dir) return;
  const name = `${await fileKey(file)}-${slot}`;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    touch(name);
    await evict(dir);
  } catch {
    // Out of quota or no writable streams (older Safari): just not cached.
    try {
      await dir.removeEntry(name);
    } catch {
      // nothing to clean up
    }
  }
}

async function evict(dir: Dir): Promise<void> {
  const entries: Array<{ name: string; size: number }> = [];
  // `values()` is missing from TypeScript's DOM lib for directory handles.
  const iterable = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
  for await (const h of iterable) {
    if (h.kind !== 'file') continue;
    const f = await (h as FileSystemFileHandle).getFile();
    entries.push({ name: h.name, size: f.size });
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= CAP_BYTES) return;
  const use = readUse();
  entries.sort((a, b) => (use[a.name] ?? 0) - (use[b.name] ?? 0));
  for (const e of entries) {
    if (total <= CAP_BYTES) break;
    try {
      await dir.removeEntry(e.name);
      touch(e.name, true);
      total -= e.size;
    } catch {
      // in use elsewhere; try the next
    }
  }
}
