/**
 * PlayerEngine — owns the <video> element (spec §3).
 *
 * Translates sync messages into playback actions and back: scheduled execution
 * (§6), differential resume (§6.2), anti-echo (§6.4), the drift state machine
 * (§7) and dropout handling (§8).
 *
 * Rules this file obeys without exception:
 *  - Date.now() is never called here. The only time source is transport.syncedNow().
 *  - No timezone, no Date parsing, no date library. Epoch integers only (§5).
 *  - Components never touch the video element; they call this class (§11).
 */

import type { SyncMessage, SyncTransport, TransportState } from '@/lib/sync/types';

/**
 * Lead for a scheduled seek. Must comfortably exceed one-way latency (§6).
 * Play derives its own lead from the measured link instead — see playLeadMs().
 */
export const SCHEDULE_LEAD_MS = 500;
/** Bounds for the measured play lead. */
const PLAY_LEAD_MIN_MS = 150;
const PLAY_LEAD_MAX_MS = 600;
/** Headroom over the measured link, for scheduling and decoder start-up. */
const PLAY_LEAD_MARGIN_MS = 80;
/** §7.1 */
export const HEARTBEAT_INTERVAL_MS = 3_000;
/** §6.4 — window in which our own programmatic DOM events are ignored. */
const SUPPRESS_MS = 250;
/** §7.3 guard 2. */
const POST_ACTION_COOLDOWN_MS = 2_000;
/** §6.2 — beyond this a frozen frame reads as broken. */
const MAX_DIFFERENTIAL_WAIT_MS = 2_000;
/** §6.2 — older than this and the peer position is a guess. */
const PEER_FRESH_MS = 5_000;
/** §8 */
const DROPOUT_MS = 8_000;
/** §12 — background tabs stutter; be tolerant rather than crying dropout. */
const HIDDEN_DROPOUT_MS = 30_000;
/** After returning to the foreground, let one heartbeat try to land first. */
const VISIBILITY_GRACE_MS = 3_000;
/** §7.3 guard 3 floor. */
const MIN_DEADBAND_S = 0.15;
/** §7.4 */
const NUDGE_DELTA = 0.02;
const NUDGE_CONVERGED_S = 0.05;
const NUDGE_MAX_MS = 10_000;
/** A nudge that has closed this much of its starting gap is working; let it run. */
const NUDGE_PROGRESS = 0.75;
const HARD_DRIFT_S = 1.0;
const HARD_DRIFT_CONFIRMATIONS = 3;
/** §6 — last stretch is spun on rAF because setTimeout drifts under load. */
const SPIN_WINDOW_MS = 100;
/** How long a starved decoder has to recover before we call it a stall (§12). */
const STALL_GRACE_MS = 600;
/**
 * Arrow-key seeks coalesce into one command. Holding a key must not spray a
 * seek per keystroke: each one is a scheduled command that cancels the previous
 * one's pending action and arms a 2s drift cooldown (§7.3), so a burst of them
 * would leave the pair fighting over positions that no longer exist.
 */
const SEEK_COALESCE_MS = 250;

/** HTMLMediaElement.HAVE_FUTURE_DATA, without touching the DOM constant. */
const HAVE_FUTURE_DATA = 3;

export type SyncHealth = 'green' | 'amber' | 'red';

export type ConnectionHealth =
  | 'connecting'
  | 'ok'
  /** We hear nothing from her, but our own link looks fine (§8 copy split). */
  | 'peer-lost'
  /** Our own link is down. */
  | 'self-lost'
  | 'reconnecting';

export interface EngineStatus {
  position: number;
  duration: number;
  playing: boolean;
  buffering: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;

  /** Measured drift in ms; positive = we are ahead. null before first heartbeat. */
  driftMs: number | null;
  deadbandMs: number;
  /** Rate nudge active. */
  correcting: boolean;
  /** Sitting out our lead before a differential resume (§6.2). */
  waitingToResume: boolean;
  /** Consecutive >1s heartbeats; a hard seek needs 3 (§7.4). */
  pendingHardDrift: number;
  /** Where a coalescing arrow-key seek is heading, before it is committed. */
  pendingSeekTarget: number | null;
  /** Behind the authority by >1s and closing it by rate alone (see §7.4 note). */
  catchingUp: boolean;

  syncHealth: SyncHealth;
  connection: ConnectionHealth;
  peerSeen: boolean;
  peerPosition: number | null;

  rttMs: number;
  rttStdDevMs: number;
  isAuthority: boolean;
  manualOffsetSec: number;
  mediaError: string | null;
}

interface PeerHeartbeat {
  position: number;
  playing: boolean;
  at: number;
}

interface Scheduled {
  cancel(): void;
}

export interface PlayerEngineOptions {
  transport: SyncTransport;
  /** Seconds added to measured drift; rescues differently-cut encodes (§11). */
  manualOffsetSec?: number;
}

export class PlayerEngine {
  private readonly transport: SyncTransport;
  private video: HTMLVideoElement | null = null;

  private readonly listeners = new Set<(s: EngineStatus) => void>();
  private unsubscribers: Array<() => void> = [];
  private detachVideo: (() => void) | null = null;

  // ---- scheduling / echo suppression
  private pending: Scheduled | null = null;
  private suppressUntil = 0;
  private cooldownUntil = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private dropoutTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- peer / drift state
  private peer: PeerHeartbeat | null = null;
  private lastProcessedAt = 0; // §7.3 guard 1
  private lastPeerContactAt = 0;
  private visibleSince = 0;
  private driftMs: number | null = null;
  private deadbandS = MIN_DEADBAND_S;
  private consecutiveHighDrift = 0;
  private highDriftSign = 0;
  private nudgeStartedAt = 0;
  private nudgeStartMagnitude = 0;
  private nudging = false;
  /**
   * Fixed at 1.0. Playback speed is deliberately not a feature: only one side
   * could ever change it, so any other value guarantees the pair separates and
   * leaves the follower nudging against it for as long as it is set.
   *
   * It survives as a named base so the drift nudge multiplies it rather than
   * writing playbackRate directly, which keeps §6.2's reset a restore-to-base
   * instead of a literal 1.0.
   */
  private readonly baseRate = 1;
  private nudgeFactor = 1;
  private pendingSeekTarget: number | null = null;
  private seekBurstOrigin = 0;
  private seekCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private catchingUp = false;

  // ---- connection
  private transportState: TransportState = 'connecting';
  private peerLost = false;
  private resyncPending = false;

  // ---- misc surface state
  private waitingToResume = false;
  private buffering = false;
  private mediaError: string | null = null;
  private manualOffsetSec: number;
  private destroyed = false;

  constructor(opts: PlayerEngineOptions) {
    this.transport = opts.transport;
    this.manualOffsetSec = opts.manualOffsetSec ?? 0;
    this.transportState = opts.transport.state;

    this.unsubscribers.push(this.transport.on((msg) => this.onMessage(msg)));
    this.unsubscribers.push(
      this.transport.onStateChange((state) => this.onTransportState(state)),
    );
  }

  /** The single legal clock (§5). */
  private now(): number {
    return this.transport.syncedNow();
  }

  // =========================================================== element wiring

  attach(video: HTMLVideoElement): () => void {
    this.detach();
    this.video = video;

    const on = <K extends keyof HTMLMediaElementEventMap>(
      type: K,
      fn: (ev: HTMLMediaElementEventMap[K]) => void,
    ) => {
      video.addEventListener(type, fn as EventListener);
      return () => video.removeEventListener(type, fn as EventListener);
    };

    const offs = [
      on('play', () => this.onNativePlay()),
      on('pause', () => this.onNativePause()),
      on('seeked', () => this.onNativeSeeked()),
      on('timeupdate', () => this.notify()),
      on('durationchange', () => this.notify()),
      on('loadedmetadata', () => this.notify()),
      on('volumechange', () => this.notify()),
      on('error', () => this.onMediaError()),
      // §12: local files rarely stall, but slow disks happen. Treat it as a
      // dropout-lite so she doesn't walk off without us.
      on('waiting', () => this.onStall()),
      on('stalled', () => this.onStall()),
      on('playing', () => this.onResumedFromStall()),
      on('canplay', () => this.onResumedFromStall()),
    ];

    this.startHeartbeat();
    this.startDropoutWatch();

    const visibility = () => {
      // Coming back from a background tab, note WHEN we returned rather than
      // resetting the liveness baseline. Resetting would erase the evidence
      // that she has actually been silent the whole time we were away, and a
      // genuinely dropped peer would then never be noticed at all.
      if (typeof document !== 'undefined' && !document.hidden) {
        this.visibleSince = this.now();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', visibility);
    }

    this.detachVideo = () => {
      for (const off of offs) off();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibility);
      }
      this.stopHeartbeat();
      this.stopDropoutWatch();
      if (this.stallTimer !== null) clearTimeout(this.stallTimer);
      this.stallTimer = null;
      this.clearPendingSeek();
      this.video = null;
    };

    this.notify();
    return () => this.detach();
  }

  private detach(): void {
    this.pending?.cancel();
    this.pending = null;
    this.detachVideo?.();
    this.detachVideo = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.detach();
    for (const un of this.unsubscribers) un();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  // ================================================================ subscribe

  subscribe(fn: (s: EngineStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.getStatus());
    return () => {
      this.listeners.delete(fn);
    };
  }

  getStatus(): EngineStatus {
    const v = this.video;
    return {
      position: v?.currentTime ?? 0,
      duration: Number.isFinite(v?.duration ?? NaN) ? (v as HTMLVideoElement).duration : 0,
      playing: v ? !v.paused : false,
      buffering: this.buffering,
      playbackRate: v?.playbackRate ?? 1,
      volume: v?.volume ?? 1,
      muted: v?.muted ?? false,

      driftMs: this.driftMs,
      deadbandMs: this.deadbandS * 1000,
      correcting: this.nudging,
      waitingToResume: this.waitingToResume,
      pendingHardDrift: this.consecutiveHighDrift,
      pendingSeekTarget: this.pendingSeekTarget,
      catchingUp: this.catchingUp,

      syncHealth: this.syncHealth(),
      connection: this.connectionHealth(),
      peerSeen: this.peer !== null,
      peerPosition: this.peer ? this.projectPeer(this.peer) : null,

      rttMs: this.transport.rttMs,
      rttStdDevMs: this.transport.rttStdDevMs,
      isAuthority: this.transport.isAuthority,
      manualOffsetSec: this.manualOffsetSec,
      mediaError: this.mediaError,
    };
  }

  private notify(): void {
    if (this.destroyed) return;
    const status = this.getStatus();
    for (const fn of this.listeners) fn(status);
  }

  private connectionHealth(): ConnectionHealth {
    if (this.transportState === 'disconnected') return 'self-lost';
    if (this.transportState === 'reconnecting') return 'reconnecting';
    if (this.transportState === 'connecting') return 'connecting';
    return this.peerLost ? 'peer-lost' : 'ok';
  }

  private syncHealth(): SyncHealth {
    if (this.connectionHealth() !== 'ok') return 'red';
    if (this.consecutiveHighDrift > 0 || this.catchingUp) return 'red';
    if (this.nudging || this.waitingToResume) return 'amber';
    return 'green';
  }

  // ============================================================ user commands

  play(): void {
    const v = this.video;
    if (!v || this.mediaError) return;
    if (this.commitPendingSeekAs(true)) return;

    // §6.2: P is the MINIMUM, because nobody can start early — waiting is only
    // available to whoever is ahead. Using max() or a midpoint would command the
    // behind client forward over footage she has not seen (§4.1).
    const mine = v.currentTime;
    const peerPos = this.freshPeerPosition();
    const position = peerPos === null ? mine : Math.min(mine, peerPos);
    const executeAt = this.now() + this.playLeadMs();

    this.transport.send({ type: 'play', position, executeAt });
    this.applyPlayCommand(position, executeAt);
  }

  /**
   * Stop now, tell her after (§6.1).
   *
   * A pause carries no executeAt: waiting out a lead before stopping would mean
   * playing on past the moment the person watching decided to stop, which is
   * the one thing a pause button must never do. The two sides therefore land on
   * slightly different positions, which is expected — §6.2 absorbs it at resume
   * with no seek.
   */
  pause(): void {
    const v = this.video;
    if (!v) return;
    if (this.commitPendingSeekAs(false)) return;
    this.cancelPending();
    this.waitingToResume = false;
    this.restoreRate();
    this.applyPause();
    this.armCooldown(this.now());
    this.transport.send({ type: 'pause', position: v.currentTime });
    this.notify();
  }

  /**
   * Lead long enough to outrun the link as it actually is right now, rather
   * than a fixed guess. Two standard deviations of jitter keeps a slow packet
   * inside the window, and the bounds stop a quiet link feeling sluggish or a
   * terrible one scheduling into next week.
   */
  private playLeadMs(): number {
    const measured = this.transport.rttMs + 2 * this.transport.rttStdDevMs + PLAY_LEAD_MARGIN_MS;
    return Math.min(PLAY_LEAD_MAX_MS, Math.max(PLAY_LEAD_MIN_MS, measured));
  }

  togglePlay(): void {
    const v = this.video;
    if (!v) return;
    if (v.paused) this.play();
    else this.pause();
  }

  seek(position: number, playAfter?: boolean): void {
    const v = this.video;
    if (!v) return;
    this.clearPendingSeek();
    const wasPlaying = playAfter ?? !v.paused;
    const executeAt = this.now() + SCHEDULE_LEAD_MS;
    this.transport.send({ type: 'seek', position, executeAt, wasPlaying });
    this.applySeekCommand(position, executeAt, wasPlaying);
  }

  /**
   * Relative seek that coalesces (rule 2). The target accumulates locally and
   * is shown on the scrubber; one seek command goes out 250ms after the last
   * keypress, so tapping the arrow key eight times is one command, not eight.
   */
  seekBy(deltaSeconds: number): { target: number; delta: number } | null {
    const v = this.video;
    if (!v) return null;
    const duration = Number.isFinite(v.duration) ? v.duration : Number.POSITIVE_INFINITY;
    const fresh = this.pendingSeekTarget === null;
    const base = fresh ? v.currentTime : this.pendingSeekTarget!;
    // Anchor the burst so the reported delta is what was actually asked for.
    // Measuring against the live position instead would shrink it by however
    // long the burst took, and six taps of 5s would report 29s.
    if (fresh) this.seekBurstOrigin = v.currentTime;
    const target = Math.min(duration, Math.max(0, base + deltaSeconds));
    this.pendingSeekTarget = target;

    if (this.seekCoalesceTimer !== null) clearTimeout(this.seekCoalesceTimer);
    this.seekCoalesceTimer = setTimeout(() => {
      this.seekCoalesceTimer = null;
      const pending = this.pendingSeekTarget;
      this.pendingSeekTarget = null;
      if (pending !== null) this.seek(pending);
    }, SEEK_COALESCE_MS);

    this.notify();
    return { target, delta: target - this.seekBurstOrigin };
  }

  /**
   * Fold a still-coalescing seek into a play/pause instead of racing it.
   * §6.3's seek already carries the resulting play state, so one command does
   * both — issuing two would have the second cancel the first's scheduled
   * action, and the seek would silently never land.
   */
  private commitPendingSeekAs(playAfter: boolean): boolean {
    const target = this.pendingSeekTarget;
    if (target === null) return false;
    this.clearPendingSeek();
    this.seek(target, playAfter);
    return true;
  }

  private clearPendingSeek(): void {
    if (this.seekCoalesceTimer !== null) clearTimeout(this.seekCoalesceTimer);
    this.seekCoalesceTimer = null;
    this.pendingSeekTarget = null;
  }

  setVolume(volume: number): void {
    if (!this.video) return;
    this.video.volume = Math.min(1, Math.max(0, volume));
    this.video.muted = this.video.volume === 0;
    this.notify();
  }

  setMuted(muted: boolean): void {
    if (!this.video) return;
    this.video.muted = muted;
    this.notify();
  }

  /** §11 — constant applied inside the drift math, not a seek. */
  setManualOffset(seconds: number): void {
    this.manualOffsetSec = seconds;
    this.notify();
  }

  /** Dev-panel affordance for acceptance tests 4 and 5: fake decoder drift. */
  debugInjectDrift(seconds: number): void {
    const v = this.video;
    if (!v) return;
    // Deliberately local and unbroadcast — this simulates the decoders
    // separating, not a user seek. No cooldown either, so the very next
    // heartbeat sees it.
    this.suppress();
    v.currentTime = Math.max(0, v.currentTime + seconds);
    this.notify();
  }

  /** Explicit resync after a dropout (§8). Authority only. */
  private sendResyncSeek(): void {
    const v = this.video;
    if (!v || !this.transport.isAuthority) return;
    const peerPos = this.freshPeerPosition();
    const position = peerPos === null ? v.currentTime : Math.min(v.currentTime, peerPos);
    const executeAt = this.now() + SCHEDULE_LEAD_MS;
    // wasPlaying:false — §8 leaves both sides paused, and the next play is a
    // normal §6.2 paused-to-playing transition driven by a real user gesture.
    this.transport.send({ type: 'seek', position, executeAt, wasPlaying: false });
    this.applySeekCommand(position, executeAt, false);
  }

  // ========================================================= inbound messages

  private onMessage(msg: SyncMessage): void {
    // Any traffic at all proves she is there (§8 liveness is separate from
    // §7.3's stale-heartbeat rejection, which is about drift maths only).
    this.lastPeerContactAt = this.now();
    if (this.peerLost) this.onPeerReturned();

    switch (msg.type) {
      case 'play':
        this.applyPlayCommand(msg.position, msg.executeAt);
        break;
      case 'pause':
        this.onPauseCommand();
        break;
      case 'seek':
        this.applySeekCommand(msg.position, msg.executeAt, msg.wasPlaying);
        break;
      case 'heartbeat':
        this.onHeartbeat(msg);
        break;
      default:
        break; // ready/chat/ping/pong are not the engine's business
    }
  }

  // ------------------------------------------------------------------ §6.2

  private applyPlayCommand(position: number, executeAt: number): void {
    const v = this.video;
    if (!v) return;
    this.cancelPending();

    // Clear any stale nudge FIRST — back to baseRate, not a literal 1.0. A
    // rate left sitting at 0.98 corrupts myLead (§12).
    this.restoreRate();

    const myLead = v.currentTime - position; // >= 0 whenever position is the min
    let delayMs = Math.max(0, myLead * 1000);

    if (delayMs > MAX_DIFFERENTIAL_WAIT_MS) {
      // Past the cap a frozen frame feels broken, so the AHEAD client seeks
      // BACKWARD to the anchor (§6.2). Never the other direction: dragging the
      // behind client forward deletes footage permanently (§4.1).
      this.applyCurrentTime(position);
      delayMs = 0;
    }

    const startAt = executeAt + delayMs;
    this.waitingToResume = delayMs > 0;
    this.armCooldown(startAt);

    this.pending = this.scheduleAt(startAt, () => {
      this.pending = null;
      this.waitingToResume = false;
      this.startPlayback();
      this.armCooldown(this.now());
      this.notify();
    });
    this.notify();
  }

  // ------------------------------------------------------------------ §6.1

  /**
   * Pause on arrival, wherever we happen to be. No seek and no correction: we
   * have overshot her by however long the packet took, and that overshoot is
   * absorbed for free at the next resume by §6.2. "Fixing" it here would be a
   * visible rewind that buys nothing (§6.1).
   */
  private onPauseCommand(): void {
    const v = this.video;
    if (!v) return;
    // A play scheduled before this pause must not survive it.
    this.cancelPending();
    this.waitingToResume = false;
    this.restoreRate();
    this.applyPause();
    this.armCooldown(this.now());
    this.notify();
  }

  // ------------------------------------------------------------------ §6.3

  private applySeekCommand(position: number, executeAt: number, wasPlaying: boolean): void {
    const v = this.video;
    if (!v) return;
    this.cancelPending();
    this.waitingToResume = false;
    this.restoreRate();
    this.resetDriftState();

    const act = () => {
      this.pending = null;
      // The commanded position is authoritative for everyone — no differential
      // here, so myLead degrades to 0 on both sides automatically (§6.2, §6.3).
      this.applyCurrentTime(position);
      if (wasPlaying) this.startPlayback();
      else this.applyPause(); // seeking while paused must still sync position (§12)
      this.armCooldown(this.now());
      this.notify();
    };

    if (executeAt <= this.now()) {
      act();
      return;
    }
    this.armCooldown(executeAt);
    this.pending = this.scheduleAt(executeAt, act);
    this.notify();
  }

  // ============================================================== §7 drift

  private onHeartbeat(msg: Extract<SyncMessage, { type: 'heartbeat' }>): void {
    // Guard 1 — stale/out-of-order rejection (§7.3). Independent per-packet
    // delay reorders messages routinely; without this an older packet
    // overwrites current state with dead information.
    if (msg.at <= this.lastProcessedAt) return;
    this.lastProcessedAt = msg.at;

    this.peer = { position: msg.position, playing: msg.playing, at: msg.at };

    const v = this.video;
    if (!v) return;

    // Project forward — never use the raw position. "I was at P at time T" means
    // the same thing whether it arrives in 40ms or 900ms (§7.1).
    const peerPos = this.projectPeer(this.peer);
    const drift = v.currentTime - peerPos + this.manualOffsetSec; // + = we're ahead
    this.driftMs = drift * 1000;

    // Guard 3 — jitter-scaled deadband (§7.3). On a link whose RTT swings, the
    // offset estimate carries that uncertainty and small drift is unmeasurable.
    this.deadbandS = Math.max(MIN_DEADBAND_S, (this.transport.rttStdDevMs / 1000) * 2);

    // Guard 2 — post-action cooldown (§7.3). Her in-flight heartbeats still
    // describe the world before our command landed. Acting on them is
    // self-inflicted oscillation.
    const inCooldown = this.now() < this.cooldownUntil;

    // §7.2 + §12 checklist: correction is gated on isAuthority in exactly one
    // place. The authority still MEASURES drift, so its indicator is honest.
    const mayCorrect =
      !this.transport.isAuthority &&
      !inCooldown &&
      !v.paused &&
      !this.waitingToResume &&
      !(typeof document !== 'undefined' && document.hidden);

    if (mayCorrect) this.runLadder(drift);
    this.notify();
  }

  /** §7.4 */
  private runLadder(drift: number): void {
    const magnitude = Math.abs(drift);

    // A nudge in flight is held until it converges, rather than being dropped
    // the moment it re-enters the deadband — otherwise the rate chatters on and
    // off at the band edge and never finishes the job.
    if (this.nudging && magnitude < NUDGE_CONVERGED_S) {
      this.restoreRate();
      this.consecutiveHighDrift = 0;
      this.highDriftSign = 0;
      this.catchingUp = false;
      return;
    }

    if (magnitude > HARD_DRIFT_S) {
      this.escalate(drift);
      return;
    }

    if (magnitude < this.deadbandS && !this.nudging) {
      this.consecutiveHighDrift = 0;
      this.highDriftSign = 0;
      return;
    }

    this.consecutiveHighDrift = 0;
    this.highDriftSign = 0;
    this.applyNudge(drift);
    this.checkNudgeStall(magnitude);
  }

  /**
   * §7.4 caps a nudge at 10s and says "if unconverged, escalate".
   *
   * Read literally that cap fires almost always: 2% of 10s buys 0.2s, so any
   * drift above ~0.25s would be unconverged at the cap and promoted to the hard
   * seek rung — making a visible seek the normal outcome of every measurable
   * drift, which contradicts "imperceptible", §4.2 (spend time, not position)
   * and §7's own "when in doubt, do nothing".
   *
   * So the cap is read as a STALL check. Still closing the gap -> keep going.
   * Not closing, and below the 1s seek threshold -> stop nudging rather than
   * seek over a fraction of a second; the next pause re-anchors it for free
   * (§6.2). Above 1s the ladder's own seek rung handles it, with its three
   * confirmations intact.
   */
  private checkNudgeStall(magnitude: number): void {
    if (!this.nudging || this.catchingUp) return;
    if (this.now() - this.nudgeStartedAt <= NUDGE_MAX_MS) return;

    if (magnitude < this.nudgeStartMagnitude * NUDGE_PROGRESS) {
      this.nudgeStartedAt = this.now();
      this.nudgeStartMagnitude = magnitude;
      return;
    }
    this.restoreRate();
  }

  private escalate(drift: number): void {
    const v = this.video;
    if (!v) return;

    const sign = Math.sign(drift);
    if (sign === this.highDriftSign) this.consecutiveHighDrift += 1;
    else {
      this.highDriftSign = sign;
      this.consecutiveHighDrift = 1;
    }

    // A rate nudge is self-correcting and harmless; a hard seek is visible and
    // destructive, so it needs three consecutive same-direction heartbeats —
    // roughly 9 seconds of agreement. Jitter cannot survive that filter (§7.4).
    if (this.consecutiveHighDrift < HARD_DRIFT_CONFIRMATIONS) {
      this.applyNudge(drift);
      return;
    }

    const peerPos = this.peer ? this.projectPeer(this.peer) : v.currentTime;
    const target = Math.min(v.currentTime, peerPos);

    /*
     * §7.4 gives two rules for this seek that do not agree:
     *   "resolve to min(myPosition, peerPos) per §4.1"
     *   "if the correcting client is behind, it seeks forward to catch up"
     * When we are behind, min() IS our own position, so the second rule would
     * have us skip forward over footage we have not watched. §4 is the
     * tie-breaker and it is unambiguous: "every anchor position in this spec is
     * a min(), never a max()", because deleting footage from someone's
     * experience is unacceptable while a rewatch is merely harmless.
     *
     * So: ahead -> seek back to her. Behind -> never jump forward; hold the
     * catch-up nudge (playing 2% faster loses nothing) and report it as red.
     * The next pause re-anchors it to zero for free anyway (§6.2, §7 preamble).
     */
    if (target < v.currentTime) {
      this.applyCurrentTime(target);
      this.restoreRate();
      this.armCooldown(this.now());
      this.consecutiveHighDrift = 0;
      this.highDriftSign = 0;
      this.catchingUp = false;
    } else {
      this.catchingUp = true;
      this.applyNudge(drift);
    }
  }

  private applyNudge(drift: number): void {
    const v = this.video;
    if (!v) return;
    // Ahead -> 0.98, behind -> 1.02. Imperceptible either way.
    this.nudgeFactor = 1 - Math.sign(drift) * NUDGE_DELTA;
    if (!this.nudging) {
      this.nudging = true;
      this.nudgeStartedAt = this.now();
      this.nudgeStartMagnitude = Math.abs(drift);
    }
    this.applyRate();
  }

  /**
   * Drop the nudge (§7.4) by restoring playbackRate to baseRate, which is
   * exactly the 1.0 that §12 requires before any myLead or drift computation.
   * Written as the base rather than the literal so the nudge stays a
   * multiplier over it.
   */
  private restoreRate(): void {
    this.nudging = false;
    this.catchingUp = false;
    this.nudgeFactor = 1;
    this.applyRate();
  }

  private applyRate(): void {
    const v = this.video;
    if (!v) return;
    const rate =
      this.nudgeFactor === 1
        ? this.baseRate
        : Number((this.baseRate * this.nudgeFactor).toFixed(4));
    if (v.playbackRate !== rate) v.playbackRate = rate;
  }

  private resetDriftState(): void {
    this.consecutiveHighDrift = 0;
    this.highDriftSign = 0;
    this.driftMs = null;
  }

  private projectPeer(hb: PeerHeartbeat): number {
    const elapsed = (this.now() - hb.at) / 1000;
    return hb.playing ? hb.position + Math.max(0, elapsed) : hb.position;
  }

  /** Peer position, or null when the heartbeat is too old to be worth using (§6.2). */
  private freshPeerPosition(): number | null {
    if (!this.peer) return null;
    if (this.now() - this.peer.at > PEER_FRESH_MS) return null;
    return this.projectPeer(this.peer);
  }

  // ============================================================ §7.1 heartbeat

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.sendHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendHeartbeat(): void {
    const v = this.video;
    if (!v) return;
    this.transport.send({
      type: 'heartbeat',
      position: v.currentTime,
      playing: !v.paused,
      at: this.now(),
    });
  }

  // ============================================================== §8 dropout

  private startDropoutWatch(): void {
    this.stopDropoutWatch();
    this.lastPeerContactAt = this.now();
    this.visibleSince = this.now();
    this.dropoutTimer = setInterval(() => this.checkDropout(), 1_000);
  }

  private stopDropoutWatch(): void {
    if (this.dropoutTimer !== null) clearInterval(this.dropoutTimer);
    this.dropoutTimer = null;
  }

  private checkDropout(): void {
    if (this.peerLost) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const limit = hidden ? HIDDEN_DROPOUT_MS : DROPOUT_MS;
    if (this.now() - this.lastPeerContactAt <= limit) return;
    // Just back in the foreground: her heartbeat deserves a moment to arrive
    // before we accuse her of being gone (§12).
    if (!hidden && this.now() - this.visibleSince < VISIBILITY_GRACE_MS) return;

    this.peerLost = true;
    this.resyncPending = true;
    this.cancelPending();
    this.waitingToResume = false;
    this.restoreRate();
    // Pause both sides: correction is the wrong tool for a lost connection (§8).
    this.applyPause();
    this.notify();
  }

  private onPeerReturned(): void {
    this.peerLost = false;
    // Fresh heartbeat right away so she can compute min(positions) too.
    this.sendHeartbeat();
    if (this.resyncPending && this.transport.isAuthority) {
      this.resyncPending = false;
      // Explicit scheduled seek to min(positions) — not by letting the drift
      // ladder grind toward it (§8). Delayed one beat so her heartbeat lands.
      setTimeout(() => this.sendResyncSeek(), HEARTBEAT_INTERVAL_MS);
    } else if (!this.transport.isAuthority) {
      this.resyncPending = false;
    }
    this.resetDriftState();
    this.lastProcessedAt = 0;
    this.notify();
  }

  private onTransportState(state: TransportState): void {
    const previous = this.transportState;
    this.transportState = state;

    if (state === 'disconnected' || state === 'reconnecting') {
      this.cancelPending();
      this.waitingToResume = false;
      this.restoreRate();
      this.applyPause();
      this.resyncPending = true;
    }

    if (state === 'connected' && previous === 'reconnecting') {
      // The transport has already thrown away its clock estimate and is
      // measuring afresh (§8). Drop our stale peer picture with it.
      this.peer = null;
      this.lastProcessedAt = 0;
      this.lastPeerContactAt = this.now();
      this.resetDriftState();
      this.sendHeartbeat();
    }

    this.notify();
  }

  /**
   * §12 — a slow disk stalling us is a dropout-lite; tell her rather than
   * letting her watch on alone.
   *
   * But `waiting` also fires on any ordinary seek, while the decoder refills.
   * Pausing the pair on that would turn every scrub into a stall, so this both
   * ignores events from our own programmatic actions and waits out a grace
   * window: only a decoder still starved after it is a real stall.
   */
  private onStall(): void {
    const v = this.video;
    if (!v || v.paused || this.buffering) return;
    if (this.isSuppressed()) return; // our own seek, not a starving disk
    if (this.stallTimer !== null) return;

    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const video = this.video;
      if (!video || video.paused || this.buffering) return;
      if (video.readyState >= HAVE_FUTURE_DATA) return; // it recovered on its own
      this.buffering = true;
      this.pause();
      this.notify();
    }, STALL_GRACE_MS);
  }

  private onResumedFromStall(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (!this.buffering) return;
    this.buffering = false;
    this.notify();
  }

  private onMediaError(): void {
    const err = this.video?.error;
    // §12: some .mp4 containers hold codecs Chrome won't decode (HEVC, AC3).
    // Say so, rather than showing a black rectangle.
    this.mediaError =
      err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? 'This file uses a codec your browser cannot decode (often HEVC video or AC3 audio). Try a different encode.'
        : (err?.message ?? 'The video failed to load.');
    this.cancelPending();
    this.notify();
  }

  // ====================================================== §6.4 anti-echo

  /**
   * Every programmatic play/pause/currentTime passes through these, so the
   * resulting DOM event is not re-broadcast as user intent. Without it two
   * clients command each other in an infinite loop — the single most common bug
   * in this class of app.
   */
  private suppress(): void {
    this.suppressUntil = this.now() + SUPPRESS_MS;
  }

  private isSuppressed(): boolean {
    return this.now() < this.suppressUntil;
  }

  private applyCurrentTime(position: number): void {
    const v = this.video;
    if (!v) return;
    this.suppress();
    v.currentTime = Math.max(0, position);
  }

  private applyPause(): void {
    const v = this.video;
    if (!v) return;
    this.restoreRate();
    if (v.paused) return;
    this.suppress();
    v.pause();
  }

  private startPlayback(): void {
    const v = this.video;
    if (!v) return;
    this.suppress();
    const promise = v.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {
        // Autoplay refusal: the lobby's Ready button is the required gesture
        // (§11), so this only fires if that ritual was skipped.
        this.mediaError = 'Playback was blocked. Press play again.';
        this.notify();
      });
    }
  }

  private onNativePlay(): void {
    if (this.isSuppressed()) return;
    // Keyboard or media-key play. We must not run ahead of her, so stop and
    // re-enter through the scheduled path.
    this.applyPause();
    this.play();
  }

  private onNativePause(): void {
    if (this.isSuppressed()) return;
    this.pause();
  }

  private onNativeSeeked(): void {
    if (this.isSuppressed()) return;
    const v = this.video;
    if (!v) return;
    this.seek(v.currentTime);
  }

  // ================================================== scheduling primitives

  private cancelPending(): void {
    this.pending?.cancel();
    this.pending = null;
  }

  private armCooldown(fromAt: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, fromAt + POST_ACTION_COOLDOWN_MS);
  }

  /**
   * §6: setTimeout drifts tens of ms under load, so it only gets us close.
   * The last stretch is spun on rAF against syncedNow().
   */
  private scheduleAt(targetAt: number, run: () => void): Scheduled {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelFrame: (() => void) | null = null;

    const spin = () => {
      cancelFrame = null;
      if (cancelled) return;
      if (this.now() >= targetAt) {
        run();
        return;
      }
      cancelFrame = this.nextFrame(spin);
    };

    const remaining = targetAt - this.now();
    if (remaining <= SPIN_WINDOW_MS) spin();
    else timer = setTimeout(spin, remaining - SPIN_WINDOW_MS);

    return {
      cancel() {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
        cancelFrame?.();
      },
    };
  }

  /**
   * rAF while visible. A hidden tab stops firing rAF entirely, which would
   * strand a scheduled command forever, so fall back to a timer there (§12).
   */
  private nextFrame(fn: () => void): () => void {
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!hidden && typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(() => fn());
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(fn, 8);
    return () => clearTimeout(id);
  }
}
