/**
 * ClockSync (§5.1) — the four-stamp estimate, who applies it, and the loss
 * probe §8 sizes itself from.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockSync } from '@/lib/sync/clock';
import type { SyncMessage } from '@/lib/sync/types';
import { advance, now, useFakeClock } from './harness/clock';

/** One burst is 7 pings, 120ms apart, then a 3s timeout for stragglers. */
const BURST_MS = 6 * 120 + 3_000 + 50;
/** RESYNC_INTERVAL_MS, plus room for the burst that follows it. */
const RESYNC_MS = 30_000 + BURST_MS;
/** CONVERGING_INTERVAL_MS, likewise. */
const CONVERGING_MS = 3_000 + BURST_MS;

interface Link {
  /** How far the peer's clock is ahead of ours. Mutable: a path can move. */
  skewMs: number;
  /** One-way delay, each way. */
  legMs: number;
  /** Drop every Nth ping, for the loss probe. */
  dropEvery?: number;
  /** Time the responder itself sits on the ping, between its t1 and t2. */
  processingMs?: number;
}

/**
 * A peer that answers pings the way the real one does: both stamps on its own
 * raw clock, the answer arriving after the outbound leg, its own processing,
 * and the inbound leg. Stateful, because `dropEvery` counts.
 */
function clockOnLink(link: Link, opts: { isAuthority?: boolean; reference?: 'peer' | 'server' } = {}) {
  let seen = 0;
  // A box, because the responder has to reach the ClockSync it is answering,
  // and that does not exist until after its own `send` is handed over.
  const box: { clock: ClockSync | null } = { clock: null };
  box.clock = new ClockSync({
    isAuthority: opts.isAuthority ?? false,
    reference: opts.reference,
    send: (msg: SyncMessage) => {
      if (msg.type !== 'ping') return;
      seen++;
      if (link.dropEvery && seen % link.dropEvery === 0) return;
      const processing = link.processingMs ?? 0;
      const t1 = now() + link.legMs + link.skewMs;
      const t2 = t1 + processing;
      setTimeout(
        () => box.clock?.handleMessage({ type: 'pong', t0: msg.t0, t1, t2 }),
        link.legMs * 2 + processing,
      );
    },
  });
  return box.clock;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ClockSync', () => {
  it('estimates the offset to the peer and reports the round trip', async () => {
    useFakeClock();
    const clock = clockOnLink({ skewMs: 2_000, legMs: 30 });

    clock.start();
    await advance(BURST_MS);

    expect(clock.hasEstimate).toBe(true);
    // 2s skew, 60ms round trip: the estimate must find the skew, not the trip.
    expect(clock.offsetMs).toBeCloseTo(2_000, -1);
    expect(clock.rttMs).toBeGreaterThanOrEqual(55);
    expect(clock.rttMs).toBeLessThanOrEqual(65);
    expect(clock.syncedNow() - now()).toBeCloseTo(2_000, -1);
    clock.stop();
  });

  it("subtracts the responder's processing time from the round trip", async () => {
    useFakeClock();
    const clock = clockOnLink({ skewMs: 0, legMs: 25, processingMs: 200 });

    clock.start();
    await advance(BURST_MS);

    // 50ms on the wire, 200ms sitting in the responder. Only the wire is rtt,
    // and the offset must not be dragged by the gap between t1 and t2.
    expect(clock.rttMs).toBeGreaterThanOrEqual(45);
    expect(clock.rttMs).toBeLessThanOrEqual(55);
    expect(Math.abs(clock.offsetMs)).toBeLessThan(10);
    clock.stop();
  });

  it('takes the offset from the fastest sample, not the median', async () => {
    useFakeClock();
    let n = 0;
    const box: { clock: ClockSync | null } = { clock: null };
    // One clean sample among six with a badly asymmetric outbound leg. A median
    // would land halfway into the bias; the minimum-delay rule picks the clean
    // one.
    box.clock = new ClockSync({
      isAuthority: false,
      send: (msg) => {
        if (msg.type !== 'ping') return;
        n++;
        const outbound = n === 3 ? 20 : 400;
        const inbound = 20;
        const t1 = now() + outbound;
        setTimeout(
          () => box.clock?.handleMessage({ type: 'pong', t0: msg.t0, t1, t2: t1 }),
          outbound + inbound,
        );
      },
    });
    const clock = box.clock;

    clock.start();
    await advance(BURST_MS);

    // The biased samples read ~190ms of phantom offset; the clean one reads 0.
    expect(Math.abs(clock.offsetMs)).toBeLessThan(15);
    clock.stop();
  });

  it('smooths later estimates instead of stepping the offset', async () => {
    useFakeClock();
    const link: Link = { skewMs: 1_000, legMs: 20 };
    const clock = clockOnLink(link);

    clock.start();
    await advance(BURST_MS);
    expect(clock.offsetMs).toBeCloseTo(1_000, -1);

    // The path moves by a second. A step would teleport every scheduled
    // executeAt, so each burst may only close a quarter of the gap — the
    // estimate has to crawl toward the truth over several of them, and a
    // disagreement this large also switches the cadence to CONVERGING.
    link.skewMs = 2_000;
    await advance(RESYNC_MS);
    const afterFirstBursts = clock.offsetMs;
    expect(afterFirstBursts).toBeGreaterThan(1_100);
    expect(afterFirstBursts).toBeLessThan(1_700);

    await advance(CONVERGING_MS * 4);
    expect(clock.offsetMs).toBeGreaterThan(afterFirstBursts);
    expect(clock.offsetMs).toBeLessThanOrEqual(2_000);
    clock.stop();
  });

  it('re-measures faster while a moved path converges', async () => {
    useFakeClock();
    const link: Link = { skewMs: 0, legMs: 20 };
    const clock = clockOnLink(link);

    clock.start();
    await advance(BURST_MS);
    const settled = clock.offsetMs;

    // Far past DISAGREEMENT_MS, so this burst switches the cadence to 3s.
    link.skewMs = 500;
    await advance(RESYNC_MS);
    const first = clock.offsetMs;
    expect(first).toBeGreaterThan(settled + 50);

    // On the 30s cadence nothing would have happened yet; on the converging
    // one there is time for several more bursts.
    await advance(CONVERGING_MS);
    expect(clock.offsetMs).toBeGreaterThan(first + 20);
    clock.stop();
  });

  it('measures loss from the pings that never came back', async () => {
    useFakeClock();
    const clock = clockOnLink({ skewMs: 0, legMs: 20, dropEvery: 2 });

    clock.start();
    await advance(BURST_MS);

    // 3 of 7 dropped.
    expect(clock.lossRate).toBeCloseTo(3 / 7, 2);
    clock.stop();
  });

  it('reports total loss when nothing answers, and keeps retrying', async () => {
    useFakeClock();
    const sent: SyncMessage[] = [];
    const clock = new ClockSync({ send: (m) => sent.push(m), isAuthority: false });

    clock.start();
    await advance(BURST_MS);
    expect(clock.lossRate).toBe(1);
    expect(clock.hasEstimate).toBe(false);

    // EMPTY_BURST_RETRY_MS is 2s, not the 30s resync cadence: an unanswered
    // burst usually means the peer is not here yet.
    const before = sent.length;
    await advance(2_000 + BURST_MS);
    expect(sent.length).toBeGreaterThan(before);
    clock.stop();
  });

  describe('who applies the offset', () => {
    it('leaves the peer-mode authority on its own raw clock', async () => {
      useFakeClock();
      const clock = clockOnLink({ skewMs: 5_000, legMs: 20 }, { isAuthority: true });

      clock.start();
      await advance(BURST_MS);

      // The authority's clock IS the shared timeline: applying an estimate
      // would swap the two timelines rather than meet in the middle.
      expect(clock.offsetMs).toBe(0);
      expect(clock.syncedNow()).toBe(now());
      expect(clock.hasEstimate).toBe(true);
      clock.stop();
    });

    it('makes a server-mode authority apply its offset like anyone else', async () => {
      useFakeClock();
      const clock = clockOnLink(
        { skewMs: 3_000, legMs: 20 },
        { isAuthority: true, reference: 'server' },
      );

      clock.start();
      await advance(BURST_MS);

      // Authority is a correction role, not a time role: in server mode both
      // sides align to the relay, so this one applies its estimate too.
      expect(clock.offsetMs).toBeCloseTo(3_000, -1);
      expect(clock.syncedNow() - now()).toBeCloseTo(3_000, -1);
      clock.stop();
    });

    it('never puts a client stamp on the wire in server mode', () => {
      useFakeClock();
      const sent: SyncMessage[] = [];
      const clock = new ClockSync({
        send: (m) => sent.push(m),
        isAuthority: false,
        reference: 'server',
      });

      const consumed = clock.handleMessage({ type: 'ping', t0: now() });

      expect(consumed).toBe(true); // still clock traffic; the app must not see it
      expect(sent).toHaveLength(0); // but the relay answers pings, not us
    });

    it('answers a peer-mode ping with raw stamps', () => {
      useFakeClock();
      const sent: SyncMessage[] = [];
      const clock = new ClockSync({ send: (m) => sent.push(m), isAuthority: false });

      clock.handleMessage({ type: 'ping', t0: 12_345 });

      const pong = sent[0];
      expect(pong.type).toBe('pong');
      if (pong.type !== 'pong') throw new Error('unreachable');
      expect(pong.t0).toBe(12_345);
      // Raw clock, not syncedNow(): folding our own estimate into the answer
      // would feed it back into the peer's and run away.
      expect(pong.t1).toBe(now());
      expect(pong.t2).toBe(now());
    });
  });

  it('drops the estimate on reset so the next burst lands whole', async () => {
    useFakeClock();
    const link: Link = { skewMs: 1_000, legMs: 20 };
    const clock = clockOnLink(link);

    clock.start();
    await advance(BURST_MS);
    expect(clock.offsetMs).toBeCloseTo(1_000, -1);

    // §8: after a reconnect the old offset is stale, so the first estimate
    // after reset is applied whole rather than smoothed into a dead one.
    link.skewMs = 4_000;
    clock.reset();
    expect(clock.hasEstimate).toBe(false);
    await advance(BURST_MS);
    expect(clock.offsetMs).toBeCloseTo(4_000, -1);
    clock.stop();
  });

  it('ignores a pong that arrives after its burst was finalized', async () => {
    useFakeClock();
    const clock = new ClockSync({ send: () => {}, isAuthority: false });
    clock.start();
    await advance(BURST_MS);
    expect(clock.hasEstimate).toBe(false);

    // A straggler from the timed-out burst must not become an estimate of one.
    clock.handleMessage({ type: 'pong', t0: now() - 50, t1: now() + 9_000, t2: now() + 9_000 });

    expect(clock.hasEstimate).toBe(false);
    expect(clock.offsetMs).toBe(0);
    clock.stop();
  });
});
