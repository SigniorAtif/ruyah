/**
 * One knob that moves fake timers and the film together.
 *
 * The engine schedules against `transport.syncedNow()` and then finishes the
 * last 100ms on rAF (`SPIN_WINDOW_MS`), which in node degrades to an 8ms
 * timeout. Stepping the clock in slices — rather than one big jump — is what
 * lets that spin actually converge, and it is also what makes a rate nudge
 * visible: the film moves a slice at a time at whatever `playbackRate` is
 * currently set.
 */

import { vi } from 'vitest';
import type { FakeVideo } from './fakeVideo';

/** Small enough for the rAF spin, large enough that a 30s test is not slow. */
const SLICE_MS = 5;

export function useFakeClock(start = 1_700_000_000_000): void {
  vi.useFakeTimers({
    now: start,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
}

/** Advance timers and any attached videos by `ms` of wall time. */
export async function advance(ms: number, videos: FakeVideo[] = []): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(SLICE_MS, left);
    for (const v of videos) v.tick(step);
    await vi.advanceTimersByTimeAsync(step);
    left -= step;
  }
}

export function now(): number {
  return Date.now();
}
