/**
 * PlayerEngine §7 — the drift ladder, its three guards, and who is allowed to
 * correct at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerEngine } from '@/lib/player/engine';
import { advance, now, useFakeClock } from './harness/clock';
import { FakeTransport } from './harness/fakeTransport';
import { asVideoElement, FakeVideo } from './harness/fakeVideo';

let video: FakeVideo;
let transport: FakeTransport;
let engine: PlayerEngine;

const step = (ms: number) => advance(ms, [video]);

function build(opts: { isAuthority?: boolean; manualOffsetSec?: number } = {}) {
  video = new FakeVideo(() => now());
  transport = new FakeTransport(() => now(), { isAuthority: opts.isAuthority });
  engine = new PlayerEngine({ transport, manualOffsetSec: opts.manualOffsetSec });
  engine.attach(asVideoElement(video));
}

/**
 * Get playing at `position`, with the §7.3 cooldown expired and the adopt
 * window behind us — the state the ladder is actually specified against.
 */
async function playingAt(position: number) {
  video.place(position);
  engine.play();
  await step(transport.last('play')!.executeAt - now() + 50);
  // POST_ACTION_COOLDOWN_MS is 2s from the play landing.
  await step(2_200);
  video.seeks.length = 0;
}

/**
 * A heartbeat putting the peer `driftS` behind us (positive = we are ahead).
 *
 * The clock moves first, because guard 1 (§7.3) drops any heartbeat stamped at
 * or before the last one processed — two in the same millisecond are one
 * heartbeat as far as the engine is concerned, which is the point of the
 * guard. `gapMs` defaults to a slice rather than the real 3s cadence so a test
 * can make its point without the film running away underneath it.
 */
async function peerBehindBy(driftS: number, gapMs = 50) {
  await step(gapMs);
  transport.receive({
    type: 'heartbeat',
    position: video.currentTime - driftS,
    playing: true,
    at: now(),
  });
}

beforeEach(() => {
  useFakeClock();
  build();
});

afterEach(() => {
  engine.destroy();
  vi.useRealTimers();
});

describe('drift measurement (§7.1)', () => {
  it('projects the peer forward rather than trusting a stale position', async () => {
    await playingAt(100);

    // "I was at 100 at time T" — arriving 900ms late means she is at ~100.9.
    const at = now() - 900;
    transport.receive({ type: 'heartbeat', position: video.currentTime, playing: true, at });

    // Using the raw position would read as us being 0.9s ahead of her.
    expect(engine.getStatus().driftMs!).toBeLessThan(-800);
  });

  it('does not project a paused peer', async () => {
    await playingAt(100);
    const at = now() - 2_000;

    transport.receive({ type: 'heartbeat', position: 100, playing: false, at });

    // She is stopped at 100 and stays there; we have played on.
    expect(engine.getStatus().driftMs!).toBeGreaterThan(1_500);
  });

  it('folds the manual offset into the measurement (§11)', async () => {
    engine.destroy();
    build({ manualOffsetSec: 2 });
    await playingAt(100);

    await peerBehindBy(0);

    // Different encodes: the offset says "her 100 is our 102", so a raw match
    // is really a 2s lead.
    expect(engine.getStatus().driftMs!).toBeCloseTo(2_000, -2);
  });

  it('rejects a heartbeat older than the last one processed (guard 1)', async () => {
    await playingAt(100);
    const fresh = now();
    transport.receive({ type: 'heartbeat', position: 100, playing: true, at: fresh });
    const afterFresh = engine.getStatus().driftMs;

    // Independent per-packet delay reorders messages; an older packet must not
    // overwrite current state with dead information.
    transport.receive({ type: 'heartbeat', position: 20, playing: true, at: fresh - 5_000 });

    expect(engine.getStatus().driftMs).toBe(afterFresh);
  });
});

describe('the ladder (§7.4)', () => {
  it('leaves small drift alone', async () => {
    await playingAt(100);

    await peerBehindBy(0.05); // inside MIN_DEADBAND_S

    expect(video.playbackRate).toBe(1);
    expect(video.seeks).toHaveLength(0);
  });

  it('nudges the rate down when ahead and up when behind', async () => {
    await playingAt(100);

    await peerBehindBy(0.5);
    expect(video.playbackRate).toBeCloseTo(0.98, 5);
    expect(video.seeks).toHaveLength(0); // never a seek at this rung

    // Converged, then the other way round.
    await peerBehindBy(0);
    await step(100);
    await peerBehindBy(-0.5);
    expect(video.playbackRate).toBeCloseTo(1.02, 5);
  });

  it('actually closes the gap by playing slower', async () => {
    await playingAt(100);
    await peerBehindBy(0.5);
    const before = video.currentTime;

    await step(10_000);

    // 2% of 10s is 0.2s of position given back, which is the whole mechanism:
    // time is spent, position is never taken away (§4.2).
    expect(video.currentTime).toBeCloseTo(before + 9.8, 1);
    expect(video.seeks).toHaveLength(0);
  });

  it('holds a nudge until it converges instead of chattering at the band edge', async () => {
    await playingAt(100);
    await peerBehindBy(0.5);
    expect(video.playbackRate).toBeCloseTo(0.98, 5);

    // Back inside the deadband but not yet converged: dropping the rate here
    // is what makes it flap on and off and never finish.
    await peerBehindBy(0.1);
    expect(video.playbackRate).toBeCloseTo(0.98, 5);

    await peerBehindBy(0.02); // under NUDGE_CONVERGED_S
    expect(video.playbackRate).toBe(1);
  });

  it('widens the deadband on a jittery link, but only so far', async () => {
    await playingAt(100);

    transport.rttStdDevMs = 90; // 2 x 90ms = 180ms
    await peerBehindBy(0.1);
    expect(engine.getStatus().deadbandMs).toBeCloseTo(180, 0);
    expect(video.playbackRate).toBe(1); // 100ms sits inside it

    // Past MAX_DEADBAND_S the honest reading is "too noisy to measure on",
    // not "in sync", so the band stops growing and correction resumes.
    transport.rttStdDevMs = 5_000;
    await peerBehindBy(0.5);
    expect(engine.getStatus().deadbandMs).toBeCloseTo(400, 0);
    expect(video.playbackRate).toBeCloseTo(0.98, 5);
  });

  it('needs three same-direction heartbeats before a hard seek', async () => {
    await playingAt(100);

    await peerBehindBy(3);
    expect(video.seeks).toHaveLength(0);
    expect(engine.getStatus().pendingHardDrift).toBe(1);

    await peerBehindBy(3);
    expect(video.seeks).toHaveLength(0);
    expect(engine.getStatus().pendingHardDrift).toBe(2);

    await peerBehindBy(3);
    // Third in a row, same sign: roughly nine seconds of agreement, which
    // jitter cannot survive.
    expect(video.seeks).toHaveLength(1);
    expect(video.seeks[0].to).toBeLessThan(video.seeks[0].from);
  });

  it('resets the confirmation count when the drift changes sign', async () => {
    await playingAt(100);

    await peerBehindBy(3);
    await peerBehindBy(3);
    await peerBehindBy(-3); // she is now ahead of us instead
    expect(engine.getStatus().pendingHardDrift).toBe(1);
    expect(video.seeks).toHaveLength(0);
  });

  it('never seeks forward to catch up — it rides the nudge instead', async () => {
    await playingAt(100);

    // We are 3s BEHIND. min() is our own position, so a "seek to catch up"
    // would skip footage we have not watched (§4.1).
    for (let i = 0; i < 4; i++) await peerBehindBy(-3, 3_000);

    expect(video.seeks).toHaveLength(0);
    expect(video.playbackRate).toBeCloseTo(1.02, 5);
    expect(engine.getStatus().catchingUp).toBe(true);
    expect(engine.getStatus().syncHealth).toBe('red');
  });

  it('stops nudging when ten seconds of it has not closed the gap', async () => {
    await playingAt(100);

    // A drift that will not move: every heartbeat reports the same gap.
    for (let i = 0; i < 5; i++) await peerBehindBy(0.5, 3_000);

    // NUDGE_MAX_MS is read as a stall check, not as "escalate to a seek":
    // seeking over half a second would be a visible jump for nothing.
    expect(video.playbackRate).toBe(1);
    expect(video.seeks).toHaveLength(0);
  });
});

describe('who corrects (§7.2)', () => {
  it('never corrects while holding authority, but still measures', async () => {
    engine.destroy();
    build({ isAuthority: true });
    await playingAt(100);

    await peerBehindBy(5);
    await peerBehindBy(5);
    await peerBehindBy(5);

    // The indicator stays honest — the drift is real and shown — but the
    // authority is the thing that never moves.
    expect(engine.getStatus().driftMs).toBeGreaterThan(4_000);
    expect(video.seeks).toHaveLength(0);
    expect(video.playbackRate).toBe(1);
  });

  it('ignores heartbeats inside the post-action cooldown (guard 2)', async () => {
    video.place(100);
    engine.play();
    await step(transport.last('play')!.executeAt - now() + 50);
    video.seeks.length = 0;

    // Her in-flight heartbeats still describe the world before our play landed.
    await peerBehindBy(0.6);

    expect(video.playbackRate).toBe(1);
  });

  it('does not correct while paused', async () => {
    await playingAt(100);
    engine.pause();
    await step(2_500);

    await peerBehindBy(0.8);

    expect(video.playbackRate).toBe(1);
    expect(video.seeks).toHaveLength(0);
  });

  it('does not correct while waiting out a differential resume', async () => {
    video.place(101.5);
    transport.receive({ type: 'heartbeat', position: 100, playing: false, at: now() });
    engine.play();
    await step(transport.last('play')!.executeAt - now() + 20);
    expect(engine.getStatus().waitingToResume).toBe(true);
    video.seeks.length = 0;

    await peerBehindBy(1.5);

    // The wait IS the correction; nudging on top of it would double-count.
    expect(video.playbackRate).toBe(1);
    expect(video.seeks).toHaveLength(0);
  });
});

describe('health (§7.3)', () => {
  it('reads green inside the deadband, amber while correcting, red past a second', async () => {
    await playingAt(100);

    await peerBehindBy(0.02);
    expect(engine.getStatus().syncHealth).toBe('green');

    await peerBehindBy(0.4);
    expect(engine.getStatus().syncHealth).toBe('amber');

    await peerBehindBy(2);
    expect(engine.getStatus().syncHealth).toBe('red');
  });
});
