/**
 * PlayerEngine §8 — liveness. When silence counts as absence, how many probes
 * it takes on a lossy link, and how both sides get out of it again.
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

beforeEach(() => {
  useFakeClock();
  video = new FakeVideo(() => now());
  transport = new FakeTransport(() => now());
  engine = new PlayerEngine({ transport });
  engine.attach(asVideoElement(video));
});

afterEach(() => {
  engine.destroy();
  vi.useRealTimers();
});

/** Playing, with the peer alive and heard from. */
async function playing() {
  video.place(100);
  engine.play();
  await step(transport.last('play')!.executeAt - now() + 50);
  transport.receive({ type: 'heartbeat', position: video.currentTime, playing: true, at: now() });
}

describe('declaring a peer lost', () => {
  it('holds on through the silence, then probes before believing it', async () => {
    await playing();

    // DROPOUT_MS is 8s. Nothing should happen before it.
    await step(7_000);
    expect(engine.getStatus().connection).toBe('ok');

    // Past the limit, silence only opens the suspect phase: one probe a tick.
    await step(2_000);
    expect(engine.getStatus().connection).toBe('ok');

    // SUSPECT_MIN_PROBES is 3 on a clean link, one per 1s tick.
    await step(3_000);
    expect(engine.getStatus().connection).toBe('peer-lost');
    // Correction is the wrong tool for a lost connection: it pauses instead.
    expect(video.paused).toBe(true);
  });

  it('asks for more probes when the link is known to be lossy', async () => {
    await playing();
    transport.lossRate = 0.5; // p^n <= 0.01 needs 7 probes at 50%

    await step(8_500);
    const clean = engine.getStatus().connection;
    await step(3_500); // would already be lost on a clean link
    expect(clean).toBe('ok');
    expect(engine.getStatus().connection).toBe('ok');

    await step(4_000);
    expect(engine.getStatus().connection).toBe('peer-lost');
  });

  it('sizes the probes against her link too, not only ours', async () => {
    await playing();
    // She reports 50% loss in her heartbeat; ours is clean. The worse of the
    // two is what §8 has to survive, because her heartbeats are what we await.
    transport.receive({
      type: 'heartbeat',
      position: video.currentTime,
      playing: true,
      at: now() + 1,
      lossRate: 0.5,
    });

    await step(11_500);
    expect(engine.getStatus().connection).toBe('ok');

    await step(6_000);
    expect(engine.getStatus().connection).toBe('peer-lost');
  });

  it('forgives silence spanning a tick the browser never ran', async () => {
    await playing();

    // A frozen window: the clock jumps 20s but our timers never ran, so the
    // silence is ours, not hers. Blaming her here is what made two side-by-side
    // windows accuse each other the moment focus moved to a third app.
    vi.setSystemTime(now() + 20_000);
    // Long enough for the suspect phase to have run its probes and declared
    // her lost, if the slip had not been forgiven.
    await step(5_000);

    expect(engine.getStatus().connection).toBe('ok');
  });

  it('keeps probing after it has latched, so both sides can recover', async () => {
    await playing();
    await step(13_000);
    expect(engine.getStatus().connection).toBe('peer-lost');

    const before = transport.ofType('heartbeat').length;
    await step(5_000);
    const after = transport.ofType('heartbeat').length;

    // Passive waiting deadlocks when both sides declare it at once: nobody has
    // any reason to speak. One probe a second is the way out.
    expect(after).toBeGreaterThanOrEqual(before + 4);
  });

  it('comes back the instant anything arrives', async () => {
    await playing();
    await step(13_000);
    expect(engine.getStatus().connection).toBe('peer-lost');

    transport.receive({ type: 'heartbeat', position: 100, playing: false, at: now() });

    expect(engine.getStatus().connection).toBe('ok');
  });
});

describe('transport state (§8)', () => {
  it('reports our own link separately from hers', async () => {
    await playing();

    transport.setState('reconnecting');
    expect(engine.getStatus().connection).toBe('reconnecting');

    transport.setState('disconnected');
    // A different message and a different fix: this one is ours to solve.
    expect(engine.getStatus().connection).toBe('self-lost');

    transport.setState('connected');
    expect(engine.getStatus().connection).toBe('ok');
  });

  it('pauses when our own link drops', async () => {
    await playing();
    expect(video.paused).toBe(false);

    transport.setState('disconnected');

    expect(video.paused).toBe(true);
  });
});

describe('heartbeats (§7.1)', () => {
  it('sends one every three seconds, carrying position, rtt and loss', async () => {
    await playing();
    transport.rttMs = 120;
    transport.lossRate = 0.25;
    const before = transport.ofType('heartbeat').length;

    await step(9_500);

    const beats = transport.ofType('heartbeat');
    expect(beats.length).toBeGreaterThanOrEqual(before + 3);
    const last = beats[beats.length - 1];
    // Within a second of where the film is now — it was stamped when it was sent.
    expect(Math.abs(last.position - video.currentTime)).toBeLessThan(1);
    expect(last.playing).toBe(true);
    // Piggybacked so the peer can size its lead and its §8 probes against the
    // slower of the two links rather than only its own.
    expect(last.rttMs).toBe(120);
    expect(last.lossRate).toBe(0.25);
  });
});
