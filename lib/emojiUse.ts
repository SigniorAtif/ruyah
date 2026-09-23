'use client';

/**
 * Which emoji this person actually reaches for, and the quick row built from
 * it.
 *
 * The chat row used to be a fixed six. It is now the six they use most, so the
 * row earns its place instead of being a guess. Counts are per browser, never
 * sent: the peer sees the emoji in the line, not how often it was picked.
 *
 * localStorage, not sessionStorage (unlike identity in ./store): a taste in
 * emoji outlives one sitting in one room, which is the whole point of counting.
 */

import { isKnownEmoji } from './emoji';

const KEY = 'ruyah:emoji-use';

/** How many the quick row shows; the tray behind it holds everything else. */
export const QUICK_SLOTS = 6;

/**
 * The row before anything has been picked, and the filler when fewer than
 * QUICK_SLOTS emoji have been used. The old fixed row, kept as the starting
 * point so a fresh browser opens on something rather than a gap.
 */
export const QUICK_SEED: readonly string[] = ['😂', '😭', '🥺', '🥹', '🫦', '💝'];

/** Counted emoji kept; enough that the row is stable, small enough to stay tiny. */
const KEEP = 40;

/** `[times picked, when last picked]` — the second only breaks ties. */
type Use = readonly [count: number, last: number];
type Uses = Record<string, Use>;

function isUse(value: unknown): value is Use {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

/**
 * Anything malformed, or any emoji the picker no longer offers, is dropped
 * here rather than trusted into the row — the same rule ./emoji applies to a
 * peer's reaction, for the same reason.
 */
function readUses(): Uses {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    // Private mode, storage disabled, or a half-written value. The row falls
    // back to the seed; only the memory of what was picked is lost.
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const uses: Uses = {};
  for (const [emoji, use] of Object.entries(raw as Record<string, unknown>)) {
    if (isKnownEmoji(emoji) && isUse(use)) uses[emoji] = use;
  }
  return uses;
}

function writeUses(uses: Uses): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(uses));
  } catch {
    /* as above: the row still works for this sitting, it just is not remembered */
  }
}

/** Most picked first, ties to whichever was picked most recently. */
function rank(uses: Uses): string[] {
  return Object.entries(uses)
    .sort(([, a], [, b]) => b[0] - a[0] || b[1] - a[1])
    .map(([emoji]) => emoji);
}

function quickRow(uses: Uses): readonly string[] {
  const top = rank(uses).slice(0, QUICK_SLOTS);
  if (top.length === QUICK_SLOTS) return top;
  // Fewer picks than slots: the seed fills the rest, skipping any already up.
  for (const emoji of QUICK_SEED) {
    if (top.length === QUICK_SLOTS) break;
    if (!top.includes(emoji)) top.push(emoji);
  }
  return top;
}

/**
 * A tiny external store read through useSyncExternalStore, for the reason
 * ./relayConfig spells out: localStorage does not exist while the page is
 * prerendered, so the server snapshot is the seed row and the client swaps to
 * the counted one on hydration, with no mismatch and no cascading render.
 */
const listeners = new Set<() => void>();

/**
 * useSyncExternalStore compares snapshots by identity, so the row has to be
 * the same array until something actually changes, or it loops.
 */
let cached: readonly string[] | null = null;

function invalidate(): void {
  cached = null;
  for (const listener of listeners) listener();
}

export function subscribeEmojiUse(onChange: () => void): () => void {
  listeners.add(onChange);
  // 'storage' fires for OTHER tabs — a second room in a second tab counting
  // its own picks is exactly when this changes behind our back.
  window.addEventListener('storage', invalidate);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', invalidate);
  };
}

export function getQuickEmojiSnapshot(): readonly string[] {
  if (typeof window === 'undefined') return QUICK_SEED;
  if (!cached) cached = quickRow(readUses());
  return cached;
}

export const getQuickEmojiServerSnapshot = (): readonly string[] => QUICK_SEED;

/**
 * Counts one pick, from the quick row or from the tray behind it, and moves
 * the row if that changed the order.
 */
export function recordEmojiUse(emoji: string): void {
  if (typeof window === 'undefined' || !isKnownEmoji(emoji)) return;
  const uses = readUses();
  const [count = 0] = uses[emoji] ?? [];
  const next: Uses = { ...uses, [emoji]: [count + 1, Date.now()] };
  // Bounded: the least used fall off, and the row only ever reads the top few.
  const kept = rank(next).slice(0, KEEP);
  writeUses(Object.fromEntries(kept.map((e) => [e, next[e]])));
  invalidate();
}
