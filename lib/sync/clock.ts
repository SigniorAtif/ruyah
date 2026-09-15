/**
 * Clock offset estimation (spec §5.1).
 *
 * Corrects genuine OS clock skew between the two machines. Timezones are not
 * involved and never will be: Date.now() is epoch ms, which is the same number
 * on both machines at the same instant regardless of where they sit.
 *
 * This module is the ONLY place in the app allowed to call Date.now().
 * Everything else asks the transport for syncedNow().
 */

import type { SyncMessage } from './types';

/**
 * What the offset is measured against (Phase 2 §2).
 *
 * `'peer'` is Phase 1: two clients ping each other and the authority's raw
 * clock is the shared timeline. `'server'` is Phase 2: each client pings the
 * relay, which stamps t1 at receipt, and BOTH sides align to that one fixed
 * reference.
 *
 * The distinction matters because authority means two different things in the
 * two modes. In peer mode the authority is also the time reference, so it
 * applies no offset. In server mode it is purely a correction role — it still
 * never adjusts its own playback (§7.2), but its clock is no more privileged
 * than the follower's, so it applies its own offset like everyone else.
 *
 * Getting this wrong is silent: a server-mode authority that skipped its offset
 * would sit on its own unshifted clock while the follower sat on the server's,
 * leaving them the full skew apart — the exact failure the estimate exists to
 * remove.
 */
export type ClockReference = 'peer' | 'server';

/** Samples per burst. One sample is worthless; one bad packet ruins it. */
const SAMPLE_COUNT = 7;
/** Spacing between pings in a burst, so one hiccup can't poison every sample. */
const SAMPLE_SPACING_MS = 120;
/** How long to wait for the stragglers after the last ping goes out. */
const BURST_TIMEOUT_MS = 3_000;
/** Re-estimate cadence (spec §5.1). */
const RESYNC_INTERVAL_MS = 30_000;
/** Retry sooner when a burst came back empty — usually means no peer yet. */
const EMPTY_BURST_RETRY_MS = 2_000;
/**
 * A fresh estimate this far from the current one means the path really moved —
 * a route change, a network swap — rather than ordinary jitter.
 */
const DISAGREEMENT_MS = 25;
/**
 * Cadence while converging on a moved path. SMOOTHING deliberately refuses to
 * step the offset (it would teleport every scheduled executeAt), so a real
 * change needs several bursts to land; at the normal 30s cadence that is two
 * minutes of being measurably wrong. Measuring more often is the way to
 * converge quickly without ever moving the clock in a jump.
 */
const CONVERGING_INTERVAL_MS = 3_000;
/** Rolling window of RTTs used for the jitter deadband (§7.3). */
const RTT_WINDOW = 20;
/**
 * Smoothing for subsequent estimates. Spec: never hard-swap the offset
 * mid-playback — a step change would teleport every scheduled executeAt.
 */
const SMOOTHING = 0.25;

interface Sample {
  rtt: number;
  offset: number;
}

export interface ClockSyncOptions {
  /** Outbound path. Pings must traverse the same simulated link as everything else. */
  send: (msg: SyncMessage) => void;
  /**
   * The authority's clock IS the shared timeline in peer mode (see syncedNow
   * below). In server mode this is recorded but has no effect on timing.
   */
  isAuthority: boolean;
  /** Defaults to 'peer' so Phase 1's MockTransport behaviour is unchanged. */
  reference?: ClockReference;
  /** Injectable raw clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

export class ClockSync {
  readonly isAuthority: boolean;
  readonly reference: ClockReference;

  private readonly sendMsg: (msg: SyncMessage) => void;
  private readonly now: () => number;

  private offsetMsValue = 0;
  private hasEstimateValue = false;
  private rttMsValue = 0;

  /** All recent RTTs, unfiltered — the jitter deadband wants the bad ones too. */
  private rttWindow: number[] = [];

  private burst: Sample[] = [];
  private burstActive = false;
  private burstTimers: ReturnType<typeof setTimeout>[] = [];
  private nextBurstTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(opts: ClockSyncOptions) {
    this.sendMsg = opts.send;
    this.isAuthority = opts.isAuthority;
    this.reference = opts.reference ?? 'peer';
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Peer mode: the shared timeline is the AUTHORITY's clock, not a midpoint.
   *
   * If both sides added their own offset to their own clock they would swap
   * timelines rather than meet: A would report B's clock and B would report A's,
   * leaving them 2x the skew apart — worse than doing nothing. Anchoring both
   * sides to the authority's raw clock makes syncedNow() agree by construction,
   * and matches §7.2, where the authority is already the thing that never moves.
   *
   * Server mode: the shared timeline is the SERVER's clock, and both sides add
   * their own offset to reach it. The same argument applies with the server in
   * the fixed seat — and there it is strictly better, because neither side's
   * timeline depends on the other still being connected.
   */
  syncedNow(): number {
    return this.referenceIsSelf()
      ? this.now()
      : Math.round(this.now() + this.offsetMsValue);
  }

  get offsetMs(): number {
    return this.referenceIsSelf() ? 0 : this.offsetMsValue;
  }

  get hasEstimate(): boolean {
    return this.referenceIsSelf() || this.hasEstimateValue;
  }

  /**
   * True only when this client's own clock IS the reference, which happens in
   * exactly one case: the peer-mode authority. A server-mode authority is a
   * correction role, not a time role, so it measures and applies an offset like
   * anyone else.
   */
  private referenceIsSelf(): boolean {
    return this.reference === 'peer' && this.isAuthority;
  }

  get rttMs(): number {
    return this.rttMsValue;
  }

  get rttStdDevMs(): number {
    return stdDev(this.rttWindow);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.runBurst();
  }

  stop(): void {
    this.running = false;
    this.clearBurstTimers();
    if (this.nextBurstTimer !== null) {
      clearTimeout(this.nextBurstTimer);
      this.nextBurstTimer = null;
    }
    this.burstActive = false;
    this.burst = [];
  }

  /**
   * Throw away the estimate and measure again from scratch.
   * Spec §8: on reconnect the old offset is stale and the network path may have
   * changed, so the next burst is applied whole rather than smoothed into the
   * dead estimate.
   */
  reset(): void {
    this.hasEstimateValue = false;
    this.offsetMsValue = 0;
    this.rttMsValue = 0;
    this.rttWindow = [];
    if (this.running) {
      this.clearBurstTimers();
      if (this.nextBurstTimer !== null) {
        clearTimeout(this.nextBurstTimer);
        this.nextBurstTimer = null;
      }
      this.burstActive = false;
      this.burst = [];
      this.runBurst();
    }
  }

  /** Measure now — e.g. the moment a peer announces itself. */
  kick(): void {
    if (!this.running || this.burstActive) return;
    if (this.nextBurstTimer !== null) {
      clearTimeout(this.nextBurstTimer);
      this.nextBurstTimer = null;
    }
    this.runBurst();
  }

  /**
   * Consume ping/pong. Returns true when the message was clock traffic and must
   * not reach application handlers.
   */
  handleMessage(msg: SyncMessage): boolean {
    if (msg.type === 'ping') {
      // Server mode: the relay terminates ping/pong and never forwards one, so
      // a ping arriving here is not ours to answer. Answering would put a
      // client stamp on the wire where only server stamps belong.
      if (this.reference === 'server') return true;
      // t1/t2 are the responder's RAW clock. Answering with syncedNow() would
      // fold our own estimate back into the peer's, and the loop would run away.
      // Both stamps are taken here, so the pair also carries whatever time this
      // handler itself costs — asymmetry the requester can then subtract.
      const t1 = this.now();
      this.sendMsg({ type: 'pong', t0: msg.t0, t1, t2: this.now() });
      return true;
    }
    if (msg.type === 'pong') {
      this.recordPong(msg.t0, msg.t1, msg.t2);
      return true;
    }
    return false;
  }

  /**
   * Four-stamp NTP (§5.1).
   *
   *   t0  we sent          (our clock)
   *   t1  they received    (their clock)
   *   t2  they replied     (their clock)
   *   t3  we received      (our clock)
   *
   * rtt excludes their processing time, and the offset is the mean of the two
   * legs rather than t1 minus a midpoint. The two forms agree when t2 === t1,
   * which is what an older responder that sends no t2 degrades to.
   *
   * What this still cannot see is asymmetry in the PATH itself: with one leg
   * slower than the other by D, every estimate is wrong by D/2 and no amount
   * of sampling reveals it. That is why the simulated link splits its injected
   * latency across both directions (types.ts, NetworkConditions.latencyMs) —
   * an outbound-only delay is the pathological case, not a realistic one.
   */
  private recordPong(t0: number, t1: number, t2Raw?: number): void {
    if (!this.burstActive) return; // late straggler from a finalized burst
    const t2 = Number.isFinite(t2Raw) ? (t2Raw as number) : t1;
    const t3 = this.now();
    const rtt = t3 - t0 - (t2 - t1);
    if (rtt < 0) return; // clock went backwards mid-flight; unusable
    const offset = (t1 - t0 + (t2 - t3)) / 2; // add to my clock to get peer clock

    this.burst.push({ rtt, offset });
    this.rttWindow.push(rtt);
    if (this.rttWindow.length > RTT_WINDOW) {
      this.rttWindow.splice(0, this.rttWindow.length - RTT_WINDOW);
    }

    if (this.burst.length >= SAMPLE_COUNT) this.finalizeBurst();
  }

  private runBurst(): void {
    if (!this.running || this.burstActive) return;
    this.burstActive = true;
    this.burst = [];

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      this.burstTimers.push(
        setTimeout(() => {
          if (!this.burstActive) return;
          this.sendMsg({ type: 'ping', t0: this.now() });
        }, i * SAMPLE_SPACING_MS),
      );
    }

    this.burstTimers.push(
      setTimeout(
        () => this.finalizeBurst(),
        (SAMPLE_COUNT - 1) * SAMPLE_SPACING_MS + BURST_TIMEOUT_MS,
      ),
    );
  }

  private finalizeBurst(): void {
    if (!this.burstActive) return;
    this.burstActive = false;
    this.clearBurstTimers();

    const samples = this.burst;
    this.burst = [];

    if (samples.length === 0) {
      // No peer answering yet. Try again soon rather than waiting out 30s.
      this.scheduleNextBurst(EMPTY_BURST_RETRY_MS);
      return;
    }

    const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
    const keep = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 2)));

    // The OFFSET comes from the single fastest sample, not from a median.
    // Queueing only ever adds delay, and it adds it to one leg at a time, so a
    // slow sample is a sample whose two legs disagreed — precisely the error
    // halving the RTT cannot absorb. The fastest round trip in the burst is the
    // one least contaminated by it. (This is NTP's minimum-delay rule; a median
    // would average the good sample together with the biased ones.)
    const newOffset = byRtt[0].offset;
    // The REPORTED rtt still comes from the fast half's median: it feeds the
    // play lead and the jitter deadband, where a typical figure is wanted
    // rather than a best case.
    this.rttMsValue = median(keep.map((s) => s.rtt));

    if (!this.hasEstimateValue) {
      this.offsetMsValue = newOffset;
      this.hasEstimateValue = true;
      this.scheduleNextBurst(RESYNC_INTERVAL_MS);
      return;
    }

    const disagreement = Math.abs(newOffset - this.offsetMsValue);
    this.offsetMsValue += SMOOTHING * (newOffset - this.offsetMsValue);
    this.scheduleNextBurst(
      disagreement > DISAGREEMENT_MS ? CONVERGING_INTERVAL_MS : RESYNC_INTERVAL_MS,
    );
  }

  private scheduleNextBurst(delayMs: number): void {
    if (!this.running) return;
    if (this.nextBurstTimer !== null) clearTimeout(this.nextBurstTimer);
    this.nextBurstTimer = setTimeout(() => {
      this.nextBurstTimer = null;
      this.runBurst();
    }, delayMs);
  }

  private clearBurstTimers(): void {
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers = [];
  }
}
