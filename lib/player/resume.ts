/**
 * Where each film was left, so the next session can offer to pick it up.
 *
 * Keyed by the file's fingerprint, so the same encode is recognised whatever it
 * is called or wherever it sits on disk. Kept on this machine only, like
 * everything else about the file.
 */

const KEY = 'ruyah:resume';
/** Films remembered at once; the least recently watched falls off. */
const KEEP = 40;

interface Entry {
  position: number;
  duration: number;
  /** Epoch ms, for dropping the oldest. Only ever compared with itself. */
  savedAt: number;
}

function readAll(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

export function savePosition(fingerprint: string, position: number, duration: number): void {
  if (!fingerprint || !Number.isFinite(position) || !(duration > 0)) return;
  const all = readAll();
  all[fingerprint] = { position, duration, savedAt: Date.now() };
  const kept = Object.entries(all)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Private window or full storage: resuming just won't be offered.
  }
}

/**
 * The position worth offering for this film, or null. Not the first half
 * minute (that is starting over anyway) and not the credits (that is finished).
 */
export function resumePoint(fingerprint: string): number | null {
  const e = readAll()[fingerprint];
  if (!e || !Number.isFinite(e.position)) return null;
  if (e.position < 30 || e.position > e.duration - 120) return null;
  return e.position;
}
