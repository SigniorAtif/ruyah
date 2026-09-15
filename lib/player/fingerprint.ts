/**
 * File identity (spec §9).
 *
 * Different encodes of the same film — a different rip, a different cut, an
 * extra studio intro — mean timestamps don't correspond and sync is silently
 * meaningless. Hash the head, the tail and the exact byte size: fast even on a
 * 4GB file, and it never reads the whole thing into memory.
 */

const CHUNK_BYTES = 2 * 1024 * 1024;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function fingerprintFile(file: File): Promise<string> {
  const headEnd = Math.min(CHUNK_BYTES, file.size);
  const tailStart = Math.max(headEnd, file.size - CHUNK_BYTES);

  const head = new Uint8Array(await file.slice(0, headEnd).arrayBuffer());
  const tail =
    tailStart >= file.size
      ? new Uint8Array(0)
      : new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer());

  // Exact byte size, so two files sharing a head and tail still differ.
  const size = new Uint8Array(8);
  new DataView(size.buffer).setBigUint64(0, BigInt(file.size));

  const payload = new Uint8Array(head.length + tail.length + size.length);
  payload.set(head, 0);
  payload.set(tail, head.length);
  payload.set(size, head.length + tail.length);

  return toHex(await crypto.subtle.digest('SHA-256', payload));
}

/** Short form for the lobby. The full hash is what actually gets compared. */
export function shortFingerprint(fp: string): string {
  return fp.slice(0, 12);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * h:mm:ss from a plain number of seconds.
 *
 * Arithmetic only — no Date, no toLocaleString (§5). This is a duration, not a
 * point in time, and the app has no use for timezones anywhere.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}
