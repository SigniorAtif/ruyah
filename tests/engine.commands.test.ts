/**
 * PlayerEngine §6 — scheduled execution, the differential resume, the pause
 * that carries no lead, and seek coalescing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerEngine } from '@/lib/player/engine';
import { advance, now, useFakeClock } from './harness/clock';
import { FakeTransport } from './harness/fakeTransport';
import { asVideoElement, FakeVideo } from './harness/fakeVideo';

let video: FakeVideo;
let transport: FakeTransport;
let engine: PlayerEngine;

function build(opts: { isAuthority?: boolean; manualOffsetSec?: number } = {}) {
  video = new FakeVideo(() => now());
  transport = new FakeTransport(() => now(), { isAuthority: opts.isAuthority });
  engine = new PlayerEngine({ transport, manualOffsetSec: opts.manualOffsetSec });
  engine.attach(asVideoElement(video));
}

/** Step the world, keeping the film on the same clock as the timers. */
const step = (ms: number) => advance(ms, [video]);

beforeEach(() => {
  useFakeClock();
  build();
});

afterEach(() => {
  engine.destroy();
  vi.useRealTimers();
});

describe('play (§6, §6.2)', () => {
  it('schedules a play into the future instead of starting now', async () => {
    video.place(100);

    engine.play();

    const cmd = transport.last('play');
    expect(cmd).not.toBeNull();
    expect(cmd!.executeAt).toBeGreaterThan(now());
    // Nothing starts until executeAt: both sides have to arrive together.
    expect(video.paused).toBe(true);

    await step(cmd!.executeAt - now() + 20);
    expect(video.paused).toBe(false);
  });

  it('anchors on the minimum of the two positions, never the maximum', async () => {
    // She is behind us. Playing must not drag her forward over footage she has
    // not seen (§4.1), so the anchor is her position, not ours.
    video.place(100);
    transport.receive({ type: 'heartbeat', position: 40, playing: false, at: now() });

    engine.play();

    expect(transport.last('play')!.position).toBe(40);
  });

  it('makes the ahead client wait out its lead rather than seek back', async () => {
    // Placed first: a heartbeat arriving while we sit at zero is someone
    // rejoining a running session, and the engine lands them on the peer.
    video.place(101.2); // 1.2s ahead, inside MAX_DIFFERENTIAL_WAIT_MS
    transport.receive({ type: 'heartbeat', position: 100, playing: false, at: now() });

    engine.play();
    const executeAt = transport.last('play')!.executeAt;

    await step(executeAt - now() + 20);
    // Still sitting on the frozen frame, because it is ahead by 1.2s.
    expect(video.paused).toBe(true);
    expect(engine.getStatus().waitingToResume).toBe(true);

    await step(1_300);
    expect(video.paused).toBe(false);
    // The whole point: no seek. The lead was spent as time, not as position.
    expect(video.seeks).toHaveLength(0);
  });

  it('seeks back to the anchor when the wait would exceed the cap', async () => {
    video.place(105); // 5s ahead: a 5s frozen frame reads as broken
    transport.receive({ type: 'heartbeat', position: 100, playing: false, at: now() });

    engine.play();

    // Backward, to the anchor — never forward, which would delete footage.
    expect(video.seeks).toHaveLength(1);
    expect(video.seeks[0].to).toBe(100);
    expect(engine.getStatus().waitingToResume).toBe(false);
  });

  it('ignores a peer position too old to be trusted', () => {
    // PEER_FRESH_MS is 5s. Past that her position is a guess, so the play
    // anchors on ours alone rather than on stale information.
    video.place(200);
    transport.receive({ type: 'heartbeat', position: 10, playing: false, at: now() });
    vi.advanceTimersByTime(6_000);

    engine.play();

    expect(transport.last('play')!.position).toBe(200);
  });

  it('starts a peer-commanded play at the same instant the peer does', async () => {
    video.place(50);
    const executeAt = now() + 400;

    transport.receive({ type: 'play', position: 50, executeAt });

    await step(399);
    expect(video.paused).toBe(true);
    await step(30);
    expect(video.paused).toBe(false);
  });
});

describe('pause (§6.1)', () => {
  it('stops immediately and tells the peer afterwards', async () => {
    engine.play();
    await step(transport.last('play')!.executeAt - now() + 50);
    expect(video.paused).toBe(false);
    video.seeks.length = 0;

    engine.pause();

    // No executeAt on a pause: waiting out a lead would play on past the
    // moment the person decided to stop.
    expect(video.paused).toBe(true);
    const cmd = transport.last('pause')!;
    expect(cmd).not.toHaveProperty('executeAt');
    expect(cmd.position).toBeCloseTo(video.currentTime, 5);
  });

  it('does not correct the overshoot a relayed pause leaves behind', async () => {
    engine.play();
    await step(transport.last('play')!.executeAt - now() + 1_000);
    video.seeks.length = 0;
    const before = video.currentTime;

    // Her pause reaches us 300ms after she stopped, so we are 300ms past her.
    transport.receive({ type: 'pause', position: before - 0.3 });

    expect(video.paused).toBe(true);
    // A rewind here would be visible and buys nothing: §6.2 absorbs it free at
    // the next resume.
    expect(video.seeks).toHaveLength(0);
    expect(video.currentTime).toBeCloseTo(before, 5);
  });

  it('cancels a play that was scheduled before it', async () => {
    engine.play();
    const executeAt = transport.last('play')!.executeAt;

    transport.receive({ type: 'pause', position: video.currentTime });
    await step(executeAt - now() + 200);

    expect(video.paused).toBe(true);
  });
});

describe('seek (§6.3)', () => {
  it('schedules both sides onto the commanded position', async () => {
    video.place(10);

    engine.seek(300);
    const cmd = transport.last('seek')!;

    expect(cmd.position).toBe(300);
    expect(cmd.executeAt).toBeGreaterThan(now());
    expect(video.currentTime).toBe(10); // not yet

    await step(cmd.executeAt - now() + 20);
    expect(video.currentTime).toBe(300);
  });

  it('keeps a paused seek paused, and a playing seek playing', async () => {
    transport.receive({ type: 'seek', position: 400, executeAt: now() + 100, wasPlaying: false });
    await step(200);
    expect(video.currentTime).toBe(400);
    expect(video.paused).toBe(true);

    transport.receive({ type: 'seek', position: 500, executeAt: now() + 100, wasPlaying: true });
    await step(200);
    // Playing again, so it has moved on a little from the commanded position.
    expect(video.currentTime).toBeGreaterThanOrEqual(500);
    expect(video.currentTime).toBeLessThan(500.5);
    expect(video.paused).toBe(false);
  });

  it('coalesces a burst of arrow-key seeks into one command', async () => {
    video.place(100);

    for (let i = 0; i < 6; i++) {
      engine.seekBy(5);
      await step(50); // faster than SEEK_COALESCE_MS
    }
    const last = engine.seekBy(5)!;
    // The reported delta is measured from where the burst started, not from
    // the live position, so seven taps of 5s read as 35s.
    expect(last.delta).toBeCloseTo(35, 5);
    expect(transport.ofType('seek')).toHaveLength(0);

    await step(300);
    const cmds = transport.ofType('seek');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].position).toBeCloseTo(135, 5);
  });

  it('folds a still-coalescing seek into a play instead of racing it', async () => {
    video.place(100);
    engine.seekBy(10);

    engine.play();

    // One command, carrying both the position and the resulting play state.
    expect(transport.ofType('seek')).toHaveLength(1);
    expect(transport.ofType('play')).toHaveLength(0);
    const cmd = transport.last('seek')!;
    expect(cmd.position).toBeCloseTo(110, 5);
    expect(cmd.wasPlaying).toBe(true);

    await step(cmd.executeAt - now() + 50);
    expect(video.currentTime).toBeGreaterThanOrEqual(110);
    expect(video.paused).toBe(false);
  });

  it('executes a seek that arrives after its own executeAt immediately', () => {
    video.place(10);

    transport.receive({ type: 'seek', position: 250, executeAt: now() - 500, wasPlaying: false });

    expect(video.currentTime).toBe(250);
  });
});

describe('anti-echo (§6.4)', () => {
  it('does not re-broadcast its own programmatic seek', async () => {
    transport.receive({ type: 'seek', position: 900, executeAt: now() + 50, wasPlaying: false });
    await step(120);

    // The element fired `seeked`, but it was our own write: sending a seek back
    // would bounce the pair between two positions forever.
    expect(transport.ofType('seek')).toHaveLength(0);
  });

  it('does broadcast a seek the person made on the element itself', async () => {
    video.currentTime = 42; // as a native scrub would
    video.emit('seeked');
    await step(10);

    expect(transport.last('seek')!.position).toBe(42);
  });
});
