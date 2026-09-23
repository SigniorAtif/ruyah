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
import { AudioTrackController, nativeAudioSwitching, prepareSubtitles } from './audioTracks';
import { primaryLanguage } from './probe';
import { readSubtitleFile, subtitleLabel } from './subtitles';

/**
 * Lead for a scheduled seek. Must comfortably exceed one-way latency (§6).
 * Play derives its own lead from the measured link instead — see playLeadMs().
 */
export const SCHEDULE_LEAD_MS = 500;
/** Bounds for the measured play lead. */
const PLAY_LEAD_MIN_MS = 150;
/**
 * The ceiling has to clear a whole relayed hop, not half of one. A play travels
 * sender -> relay -> peer, and the lead is built from the SENDER's round trip to
 * the relay, which says nothing about the peer's leg. Capping at the old 600ms
 * meant any link slower than that delivered the command after its own executeAt
 * had already passed: the peer then started late by the overshoot, with nothing
 * to correct it until the next pause. A second and a bit is still well under the
 * point where pressing play feels unresponsive.
 */
const PLAY_LEAD_MAX_MS = 1_500;
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
/** Cadence of the §8 watchdog, and the baseline its own lateness is judged against. */
const DROPOUT_TICK_MS = 1_000;
/**
 * A watchdog tick this late means the browser stopped running our timers — the
 * window lost focus, or got occluded — so the silence we are about to blame on
 * her is our own. Small enough that ordinary scheduling noise never trips it.
 */
const TIMER_STARVED_MS = 1_500;
/** While the peer is presumed lost, probe this often to re-establish contact. */
const PROBE_INTERVAL_MS = 1_000;
/**
 * Before declaring her gone, ask directly and wait — §8's limit on its own is a
 * bet that a couple of 3s heartbeats survive the link, and on a lossy one that
 * bet loses constantly. At 50% loss two missed heartbeats happen one window in
 * eight, which is a false alarm every half minute.
 *
 * So silence past the limit only opens a SUSPECT phase: one probe per tick,
 * declared lost only when every one of them also goes unanswered. The count is
 * sized from measured loss to keep a false alarm near this probability, with a
 * floor so a clean link still confirms, and a ceiling so a hopeless link is
 * still called within a few seconds rather than never.
 */
const SUSPECT_FALSE_ALARM = 0.01;
const SUSPECT_MIN_PROBES = 3;
const SUSPECT_MAX_PROBES = 10;
/** §12 — background tabs stutter; be tolerant rather than crying dropout. */
const HIDDEN_DROPOUT_MS = 30_000;
/** After returning to the foreground, let one heartbeat try to land first. */
const VISIBILITY_GRACE_MS = 3_000;
/** §7.3 guard 3 floor. */
/** Landing on someone mid-film only happens from a standing start near zero. */
const ADOPT_FROM_S = 2;
/** And only if they are properly into it, not a second ahead of us. */
const ADOPT_MIN_S = 5;

const MIN_DEADBAND_S = 0.15;
/**
 * §7.3 guard 3 ceiling. The deadband is scaled by measured jitter, and nothing
 * bounded it: a link jittering by half a second bought itself a deadband wide
 * enough to sit a real, visible desync inside and call it green forever. Past
 * this the honest reading is not "within tolerance", it is "this link is too
 * noisy to measure on", and the right response is still to correct.
 */
const MAX_DEADBAND_S = 0.4;
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

/** A subtitle or audio track, as the pickers show it. */
export interface MediaTrack {
  /** Index into the element's own track list. */
  index: number;
  label: string;
  language: string;
}

/**
 * AudioTrackList is real in Safari and behind a flag in Chromium, and missing
 * from TypeScript's DOM lib either way. Only what is used here is declared.
 */
interface AudioTrackLike {
  label: string;
  language: string;
  enabled: boolean;
}
interface AudioTrackListLike extends EventTarget {
  readonly length: number;
  [index: number]: AudioTrackLike;
}
function audioTracksOf(v: HTMLVideoElement | null): AudioTrackListLike | null {
  return (v as unknown as { audioTracks?: AudioTrackListLike } | null)?.audioTracks ?? null;
}

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
  /** Worse of the two links, 0..1 — what §8 sizes its probes against. */
  lossRate: number;
  isAuthority: boolean;
  manualOffsetSec: number;
  mediaError: string | null;

  /**
   * Subtitles and audio are local, like volume: each person reads and hears
   * their own choice, and nothing here reaches the transport.
   */
  textTracks: MediaTrack[];
  /** Index of the showing text track, or -1 for off. */
  activeTextTrack: number;
  /** Empty until the file has been read, or when it cannot be. */
  audioTracks: MediaTrack[];
  activeAudioTrack: number;
  /** A track being pulled out of the file (Chromium only), 0..1. */
  audioPreparing: { index: number; progress: number } | null;
  /** Embedded subtitles being read out of the file, 0..1. */
  subtitlesPreparing: number | null;
  audioError: string | null;
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
  /**
   * Her measured round trip, from her heartbeats (§6). A command travels
   * sender -> relay -> peer, so our own RTT covers only the first half of the
   * path; sizing a lead without this leaves every command to a peer on a slower
   * link arriving after its own executeAt, and a peer that starts late has
   * nothing to correct it until the next pause.
   */
  private peerRttMs = 0;
  private lastProcessedAt = 0; // §7.3 guard 1
  private lastPeerContactAt = 0;
  private visibleSince = 0;
  /** When the §8 watchdog last ran, so it can tell its own lateness from hers. */
  private lastWatchTickAt = 0;
  private lastProbeAt = 0;
  /** Consecutive unanswered probes in the §8 suspect phase. */
  private suspectProbes = 0;
  /** Her measured loss, from heartbeats; ours may not be the worse of the two. */
  private peerLossRate = 0;

  // ---- §8 diagnostics. Cheap counters plus a ring buffer, so the state that
  // led to a peer-lost is still there to read after it has latched.
  private heartbeatsSent = 0;
  private messagesReceived = 0;
  private lastInboundAt = 0;
  private lastInboundType = 'none';
  private probesSinceLost = 0;
  private readonly dropoutLog: string[] = [];
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
  /** <track> elements added from picked subtitle files, and their blob URLs. */
  private addedTracks: Array<{ el: HTMLTrackElement; url: string }> = [];
  /** Chromium's audio-language switching; null where the browser does it natively. */
  private audioChoice: AudioTrackController | null = null;
  /**
   * Waiting to land where the other person already is (§4.1: never skip
   * footage they have not seen — this only ever moves US).
   */
  private adoptPending = false;
  /** Embedded subtitles being read out of the file, 0..1; null when idle. */
  private subtitlesPreparing: number | null = null;
  private subtitleRun = 0;
  private onAudioSwitched: ((label: string) => void) | null = null;

  constructor(opts: PlayerEngineOptions) {
    this.transport = opts.transport;
    this.manualOffsetSec = opts.manualOffsetSec ?? 0;
    this.transportState = opts.transport.state;

    // Dev-only console handle, so a peer-lost that has already latched can be
    // read out after the fact instead of needing to be caught live.
    if (__RUYAH_DEV_TOOLS__ && typeof window !== 'undefined') {
      (window as unknown as { __ruyah?: unknown }).__ruyah = {
        dropoutReport: () => this.dropoutReport(),
        engine: this,
      };
    }

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
    // A fresh attach is either the start of a session or someone coming back to
    // one already running; the first heartbeat decides which.
    this.adoptPending = true;

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

    // Track lists are live and change as metadata arrives or a file is added.
    const tracks: Array<EventTarget | null> = [video.textTracks, audioTracksOf(video)];
    const onTracks = () => this.notify();
    for (const list of tracks) {
      list?.addEventListener('addtrack', onTracks);
      list?.addEventListener('removetrack', onTracks);
      list?.addEventListener('change', onTracks);
    }
    offs.push(() => {
      for (const list of tracks) {
        list?.removeEventListener('addtrack', onTracks);
        list?.removeEventListener('removetrack', onTracks);
        list?.removeEventListener('change', onTracks);
      }
    });

    this.startHeartbeat();
    this.startDropoutWatch();

    const visibility = () => {
      // Coming back from a background tab, note WHEN we returned rather than
      // resetting the liveness baseline. Resetting would erase the evidence
      // that she has actually been silent the whole time we were away, and a
      // genuinely dropped peer would then never be noticed at all.
      if (typeof document !== 'undefined' && !document.hidden) {
        this.visibleSince = this.now();
        // Correction is gated off while hidden (§7.2), and a throttled tab
        // sends its heartbeats minutes apart, so the pair comes back to the
        // foreground with both pictures of each other stale. Speak immediately
        // and drop the ordering guard, rather than waiting up to a full
        // heartbeat interval before the ladder can even see the gap.
        this.lastProcessedAt = 0;
        this.sendHeartbeat();
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
      for (const { el, url } of this.addedTracks) {
        el.remove();
        URL.revokeObjectURL(url);
      }
      this.addedTracks = [];
      this.audioChoice?.dispose();
      this.audioChoice = null;
      this.subtitlesPreparing = null;
      this.subtitleRun++;
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
      // While extracted audio plays, the <video> is forced silent and the
      // person's own mute lives on the controller.
      muted: this.audioChoice?.external ? this.audioChoice.muted : (v?.muted ?? false),

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
      lossRate: this.effectiveLossRate(),
      isAuthority: this.transport.isAuthority,
      manualOffsetSec: this.manualOffsetSec,
      mediaError: this.mediaError,

      ...this.trackStatus(v),
    };
  }

  private trackStatus(
    v: HTMLVideoElement | null,
  ): Pick<
    EngineStatus,
    | 'textTracks'
    | 'activeTextTrack'
    | 'audioTracks'
    | 'activeAudioTrack'
    | 'audioPreparing'
    | 'audioError'
    | 'subtitlesPreparing'
  > {
    const textTracks: MediaTrack[] = [];
    let activeTextTrack = -1;
    if (v) {
      for (let i = 0; i < v.textTracks.length; i++) {
        const t = v.textTracks[i];
        if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
        textTracks.push({ index: i, label: t.label, language: t.language });
        if (t.mode === 'showing') activeTextTrack = i;
      }
    }

    const audioTracks: MediaTrack[] = [];
    let activeAudioTrack = -1;
    let audioPreparing: EngineStatus['audioPreparing'] = null;
    let audioError: string | null = null;
    const audio = audioTracksOf(v);
    if (this.audioChoice) {
      const c = this.audioChoice.status();
      for (const t of c.tracks) {
        audioTracks.push({ index: t.index, label: t.name, language: primaryLanguage(t.language) });
      }
      activeAudioTrack = c.active;
      audioPreparing = c.preparing;
      audioError = c.error;
    } else if (audio) {
      for (let i = 0; i < audio.length; i++) {
        audioTracks.push({ index: i, label: audio[i].label, language: audio[i].language });
        if (audio[i].enabled) activeAudioTrack = i;
      }
    }
    return {
      textTracks,
      activeTextTrack,
      audioTracks,
      activeAudioTrack,
      audioPreparing,
      audioError,
      subtitlesPreparing: this.subtitlesPreparing,
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
    // Pressing play is a decision about where we are; stop waiting to be moved.
    this.adoptPending = false;
    if (this.commitPendingSeekAs(true)) return;

    // §6.2: P is the MINIMUM, because nobody can start early — waiting is only
    // available to whoever is ahead. Using max() or a midpoint would command the
    // behind client forward over footage she has not seen (§4.1).
    const mine = v.currentTime;
    const peerPos = this.freshPeerPosition();
    const position = peerPos === null ? mine : Math.min(mine, peerPos);
    const executeAt = this.now() + this.playLeadMs();

    this.transport.send({ type: 'play', position, executeAt });
    this.applyPlayCommand(position, executeAt, false);
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
    // The slower of the two links, not ours: the command has to clear both legs
    // of sender -> relay -> peer, and our own RTT only describes the first.
    const link = Math.max(this.transport.rttMs, this.peerRttMs);
    const measured = link + 2 * this.transport.rttStdDevMs + PLAY_LEAD_MARGIN_MS;
    return Math.min(PLAY_LEAD_MAX_MS, Math.max(PLAY_LEAD_MIN_MS, measured));
  }

  /**
   * Lead for a scheduled SEEK. §6 fixes it at 500ms, which is the right floor
   * and the wrong ceiling — on a link slower than that the seek lands after its
   * own executeAt and fires late, exactly as an undersized play lead did. So:
   * never shorter than the spec's figure, but allowed to grow with the link.
   */
  private seekLeadMs(): number {
    return Math.max(SCHEDULE_LEAD_MS, this.playLeadMs());
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
    this.adoptPending = false;
    this.clearPendingSeek();
    const wasPlaying = playAfter ?? !v.paused;
    const executeAt = this.now() + this.seekLeadMs();
    this.transport.send({ type: 'seek', position, executeAt, wasPlaying });
    this.applySeekCommand(position, executeAt, wasPlaying, false);
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
    this.setMuted(this.video.volume === 0);
  }

  setMuted(muted: boolean): void {
    if (!this.video) return;
    if (this.audioChoice?.external) this.audioChoice.setMuted(muted);
    else this.video.muted = muted;
    this.audioChoice?.applyOutput();
    this.notify();
  }

  /** Show one subtitle track, or none with -1. Local only, like volume. */
  setTextTrack(index: number): void {
    const v = this.video;
    if (!v) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
      // 'disabled' rather than 'hidden': a hidden track still parses and fires cues.
      t.mode = i === index ? 'showing' : 'disabled';
    }
    this.notify();
  }

  /**
   * Switch the audio track. Only one may be enabled; flipping them on a
   * playing element can hiccup for a frame, which the drift ladder absorbs.
   */
  setAudioTrack(index: number): void {
    if (this.audioChoice) {
      void this.audioChoice.select(index);
      return;
    }
    const audio = audioTracksOf(this.video);
    if (!audio || index < 0 || index >= audio.length) return;
    for (let i = 0; i < audio.length; i++) audio[i].enabled = i === index;
    this.notify();
  }

  /**
   * Read the file's audio tracks and play the preferred language. Where the
   * browser switches tracks itself (Safari) this does nothing: the native list
   * is already in the status. `onSwitched` hears each completed switch.
   */
  useAudioFrom(file: File, onSwitched: (label: string) => void): void {
    const v = this.video;
    if (!v || nativeAudioSwitching()) return;
    this.onAudioSwitched = onSwitched;
    this.audioChoice?.dispose();
    this.audioChoice = new AudioTrackController(
      v,
      file,
      () => this.notify(),
      (label) => this.onAudioSwitched?.(label),
    );
  }

  /**
   * Add a picked .srt/.vtt as a new subtitle track and show it. Resolves to
   * the track's label; rejects with a readable message for a file it can't use.
   */
  async addSubtitleFile(file: File): Promise<string> {
    const vtt = await readSubtitleFile(file);
    const index = this.addVttTrack(vtt, subtitleLabel(file), '');
    this.setTextTrack(index);
    return subtitleLabel(file);
  }

  /** Append WebVTT text as a subtitle track, hidden; returns its textTracks index. */
  private addVttTrack(vtt: string, label: string, language: string): number {
    const v = this.video;
    if (!v) throw new Error('The player is not ready yet.');
    const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = label;
    if (language) el.srclang = language;
    el.src = url;
    v.appendChild(el);
    this.addedTracks.push({ el, url });
    // The new TextTrack is the element's own; its index is what the pickers use.
    return Array.prototype.indexOf.call(v.textTracks, el.track);
  }

  /**
   * Read the text subtitle tracks out of the file and list them with the
   * rest. None is shown until someone picks it. Runs in every browser: none of
   * them read subtitles inside an MKV on their own.
   */
  useSubtitlesFrom(file: File): void {
    const v = this.video;
    if (!v) return;
    // Only the latest call may add tracks: a detach and re-attach (React's
    // double effect in development, or a new file) starts another run, and the
    // shared job resolves for both.
    const run = ++this.subtitleRun;
    const job = prepareSubtitles(file, () => this.video?.duration ?? 0);
    const tick = () => {
      this.subtitlesPreparing = job.progress < 1 ? job.progress : null;
      this.notify();
    };
    job.listeners.add(tick);
    this.subtitlesPreparing = job.progress < 1 ? job.progress : null;
    job.promise.then(
      (subs) => {
        job.listeners.delete(tick);
        if (this.video !== v || run !== this.subtitleRun) return;
        this.subtitlesPreparing = null;
        // Names in the wild are often a release group's tag repeated on every
        // track; when they do not tell tracks apart, the format does.
        const names = subs.map((x) => x.track.name);
        const useful = (n: string) => !!n && names.filter((m) => m === n).length === 1;
        const lang = (tag: string) => {
          try {
            return tag ? (new Intl.DisplayNames(undefined, { type: 'language' }).of(primaryLanguage(tag)) ?? tag) : '';
          } catch {
            return tag;
          }
        };
        for (const { track, vtt } of subs) {
          const parts = [
            useful(track.name) ? track.name : '',
            lang(track.language),
            track.codec === 'srt' ? 'SRT' : track.codec === 'ass' ? 'ASS' : '',
            track.isDefault ? 'default' : '',
          ].filter(Boolean);
          this.addVttTrack(vtt, parts.join(' · ') || `Track ${track.index + 1}`, primaryLanguage(track.language));
        }
        this.notify();
      },
      () => {
        job.listeners.delete(tick);
        if (this.video !== v || run !== this.subtitleRun) return;
        this.subtitlesPreparing = null;
        this.notify();
      },
    );
  }

  /** §11 — constant applied inside the drift math, not a seek. */
  setManualOffset(seconds: number): void {
    this.manualOffsetSec = seconds;
    this.notify();
  }

  /** Dev-panel affordance for acceptance tests 4 and 5: fake decoder drift. */
  debugInjectDrift(seconds: number): void {
    const v = this.video;
    if (!__RUYAH_DEV_TOOLS__ || !v) return;
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
    const executeAt = this.now() + this.seekLeadMs();
    // wasPlaying:false — §8 leaves both sides paused, and the next play is a
    // normal §6.2 paused-to-playing transition driven by a real user gesture.
    this.transport.send({ type: 'seek', position, executeAt, wasPlaying: false });
    this.applySeekCommand(position, executeAt, false, false);
  }

  // ========================================================= inbound messages

  private onMessage(msg: SyncMessage): void {
    // Any traffic at all proves she is there (§8 liveness is separate from
    // §7.3's stale-heartbeat rejection, which is about drift maths only).
    this.lastPeerContactAt = this.now();
    this.messagesReceived++;
    this.lastInboundAt = this.lastPeerContactAt;
    this.lastInboundType = msg.type;
    if (this.peerLost) this.onPeerReturned();

    switch (msg.type) {
      case 'play':
        this.applyPlayCommand(msg.position, msg.executeAt, true);
        break;
      case 'pause':
        this.onPauseCommand(msg.position);
        break;
      case 'seek':
        this.applySeekCommand(msg.position, msg.executeAt, msg.wasPlaying, true);
        break;
      case 'heartbeat':
        this.onHeartbeat(msg);
        break;
      default:
        break; // ready/chat/ping/pong are not the engine's business
    }
  }

  // ------------------------------------------------------------------ §6.2

  private applyPlayCommand(position: number, executeAt: number, fromPeer: boolean): void {
    const v = this.video;
    if (!v) return;
    if (fromPeer) {
      // Same staleness problem as the pause (see notePeerState): whatever her
      // last heartbeat said, from executeAt onwards she is playing, and if we
      // leave a pre-pause heartbeat in place projectPeer keeps advancing a
      // position that stopped moving minutes ago.
      //
      // `position` is the anchor, which is a LOWER bound on where she will be —
      // she waits out her own lead if she is ahead of it. Under-reading her
      // position is the safe direction: a min() anchor that is too low costs a
      // rewatch, never a skip (§4.1). The next heartbeat replaces it with the
      // real figure within 3s.
      this.notePeerState(position, true, executeAt);
    }
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
  private onPauseCommand(position: number): void {
    const v = this.video;
    if (!v) return;
    // Her last heartbeat says `playing: true`, and projectPeer would go on
    // extrapolating from it for as long as the pause lasts — a stopped peer
    // drifting forward at 1x in our model, which then poisons the min() anchor
    // at the next resume. The pause carries her exact position, so take it.
    this.notePeerState(position, false);
    // A play scheduled before this pause must not survive it.
    this.cancelPending();
    this.waitingToResume = false;
    this.restoreRate();
    this.applyPause();
    this.armCooldown(this.now());
    this.notify();
  }

  // ------------------------------------------------------------------ §6.3

  private applySeekCommand(
    position: number,
    executeAt: number,
    wasPlaying: boolean,
    fromPeer: boolean,
  ): void {
    const v = this.video;
    if (!v) return;
    // A seek position is authoritative for both sides, so unlike the play case
    // this is her exact position from executeAt on, not a bound.
    if (fromPeer) this.notePeerState(position, wasPlaying, executeAt);
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
    if (Number.isFinite(msg.rttMs) && (msg.rttMs as number) >= 0) {
      this.peerRttMs = msg.rttMs as number;
    }
    if (Number.isFinite(msg.lossRate) && (msg.lossRate as number) >= 0) {
      this.peerLossRate = Math.min(1, msg.lossRate as number);
    }

    const v = this.video;
    if (!v) return;

    // Project forward — never use the raw position. "I was at P at time T" means
    // the same thing whether it arrives in 40ms or 900ms (§7.1).
    const peerPos = this.projectPeer(this.peer);

    if (this.adoptPending) {
      this.adoptPending = false;
      // Coming back to a session that kept running: land where they are rather
      // than sitting at the start. Without this the returning player is the one
      // the other corrects toward — and if they came back holding authority
      // (§3's sticky seat), pressing play would drag the other person back to
      // the beginning of the film.
      if (v.paused && v.currentTime < ADOPT_FROM_S && peerPos > ADOPT_MIN_S) {
        this.suppress();
        v.currentTime = peerPos;
        this.notify();
        return;
      }
    }
    const drift = v.currentTime - peerPos + this.manualOffsetSec; // + = we're ahead
    this.driftMs = drift * 1000;

    // Guard 3 — jitter-scaled deadband (§7.3). On a link whose RTT swings, the
    // offset estimate carries that uncertainty and small drift is unmeasurable.
    this.deadbandS = Math.min(
      MAX_DEADBAND_S,
      Math.max(MIN_DEADBAND_S, (this.transport.rttStdDevMs / 1000) * 2),
    );

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

  /**
   * Record what a COMMAND implies about her, so projectPeer stops extrapolating
   * a heartbeat the command has already invalidated.
   *
   * `at` may sit in the future for a scheduled command; projectPeer clamps
   * elapsed at zero, so until it arrives this reads as "she is at `position`",
   * which is exactly right. lastProcessedAt is deliberately left alone — it
   * belongs to the heartbeat ordering guard (§7.3), and bumping it to a
   * scheduled executeAt would silently drop every real heartbeat until then.
   */
  private notePeerState(position: number, playing: boolean, at?: number): void {
    this.peer = { position, playing, at: at ?? this.now() };
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
    this.heartbeatsSent++;
    this.transport.send({
      type: 'heartbeat',
      position: v.currentTime,
      playing: !v.paused,
      at: this.now(),
      rttMs: Math.round(this.transport.rttMs),
      lossRate: Number(this.transport.lossRate.toFixed(3)),
    });
  }

  // ============================================================== §8 dropout

  private startDropoutWatch(): void {
    this.stopDropoutWatch();
    this.lastPeerContactAt = this.now();
    this.visibleSince = this.now();
    this.lastWatchTickAt = this.now();
    this.dropoutTimer = setInterval(() => this.checkDropout(), DROPOUT_TICK_MS);
  }

  private stopDropoutWatch(): void {
    if (this.dropoutTimer !== null) clearInterval(this.dropoutTimer);
    this.dropoutTimer = null;
  }

  private checkDropout(): void {
    const tickAt = this.now();
    // How much later than its 1s cadence did this tick actually run? A browser
    // that is not running our timers is not running our heartbeats either, so a
    // late tick is evidence about US, not about her.
    const slip = Math.max(0, tickAt - this.lastWatchTickAt - DROPOUT_TICK_MS);
    this.lastWatchTickAt = tickAt;

    if (this.peerLost) {
      // §8 recovery used to be entirely passive: peerLost was cleared only by an
      // inbound message, and this method returned here forever. That works while
      // ONE side is lost, because the healthy side keeps heartbeating and the
      // lost side hears it within a beat. When BOTH sides declare it at the same
      // moment — which is exactly what happens when both windows are starved
      // together, e.g. focus moves to a third app — neither has any reason to
      // speak and neither watchdog ever looks again. That is a permanent
      // deadlock, and the fix is to keep talking rather than to keep waiting.
      this.probeWhileLost(tickAt);
      return;
    }

    if (slip > TIMER_STARVED_MS) {
      // Forgive exactly the interval we were frozen for. Without this the
      // strict 8s limit is applied across a gap in which we could not have
      // heard anything, and both sides accuse each other on the same tick.
      this.lastPeerContactAt += slip;
      return;
    }

    // `document.hidden` is false for a window that is merely unfocused or
    // occluded, yet a browser throttles those too — so focus has to count as
    // well, or the tolerant limit never applies in the case that needs it most:
    // two side-by-side windows while the person is looking at a third.
    const hidden =
      typeof document !== 'undefined' &&
      (document.hidden ||
        (typeof document.hasFocus === 'function' && !document.hasFocus()));
    const limit = hidden ? HIDDEN_DROPOUT_MS : DROPOUT_MS;
    if (this.now() - this.lastPeerContactAt <= limit) {
      this.suspectProbes = 0;
      return;
    }
    // Just back in the foreground: her heartbeat deserves a moment to arrive
    // before we accuse her of being gone (§12).
    if (!hidden && this.now() - this.visibleSince < VISIBILITY_GRACE_MS) return;

    // Silence is not yet absence. Ask, and keep asking, before believing it.
    const needed = this.probesBeforeLost();
    if (this.suspectProbes < needed) {
      this.suspectProbes++;
      this.sendHeartbeat();
      return;
    }

    this.peerLost = true;
    this.probesSinceLost = 0;
    this.recordDropoutEvent('declared-lost', {
      slip,
      limit,
      probes: this.suspectProbes,
      lossRate: Number(this.effectiveLossRate().toFixed(3)),
    });
    this.suspectProbes = 0;
    this.resyncPending = true;
    this.cancelPending();
    this.waitingToResume = false;
    this.restoreRate();
    // Pause both sides: correction is the wrong tool for a lost connection (§8).
    this.applyPause();
    this.notify();
  }

  /**
   * Keep speaking while we believe she is gone (§8).
   *
   * A heartbeat is the probe: it is what she is waiting for, it carries our
   * position so she can compute min() the moment she hears it, and it costs one
   * small frame a second against a relay budget of fifty. The instant either
   * side's timers resume, contact is re-established in one beat — from either
   * direction, so it no longer matters which of the two woke up first.
   */
  /**
   * Loss of the worse of the two links. Hers matters as much as ours — her
   * heartbeats are what we are waiting for — and she reports it in every one,
   * so the last figure we heard is the best available even once she goes quiet.
   */
  private effectiveLossRate(): number {
    return Math.max(this.transport.lossRate, this.peerLossRate);
  }

  /**
   * How many unanswered probes it takes to be confident, given the link.
   *
   * With independent loss p, n probes all going missing has probability p^n, so
   * the n that holds that at SUSPECT_FALSE_ALARM is log(target)/log(p).
   */
  private probesBeforeLost(): number {
    const loss = Math.min(0.95, Math.max(0, this.effectiveLossRate()));
    if (loss <= 0) return SUSPECT_MIN_PROBES;
    const needed = Math.ceil(Math.log(SUSPECT_FALSE_ALARM) / Math.log(loss));
    return Math.min(SUSPECT_MAX_PROBES, Math.max(SUSPECT_MIN_PROBES, needed));
  }

  private probeWhileLost(tickAt: number): void {
    if (tickAt - this.lastProbeAt < PROBE_INTERVAL_MS) return;
    this.lastProbeAt = tickAt;
    this.probesSinceLost++;
    this.sendHeartbeat();
    // Every tenth probe, not every one: enough to show whether the probes are
    // going out and nothing is coming back, without flooding the log.
    if (this.probesSinceLost % 10 === 0) {
      this.recordDropoutEvent('still-lost', { probes: this.probesSinceLost });
    }
  }

  /**
   * One line of §8 forensics. The engine cannot see the socket or the send
   * queue, so it asks the transport for whatever it is willing to say — via
   * feature detection, so SyncTransport stays exactly as §10 defines it.
   */
  private recordDropoutEvent(event: string, extra: Record<string, unknown>): void {
    if (!__RUYAH_DEV_TOOLS__) return;
    const doc = typeof document !== 'undefined' ? document : null;
    const transport = this.transport as { debugInfo?: () => Record<string, unknown> };
    const fields: Record<string, unknown> = {
      event,
      ...extra,
      sinceContactMs: this.lastPeerContactAt ? this.now() - this.lastPeerContactAt : null,
      sinceInboundMs: this.lastInboundAt ? this.now() - this.lastInboundAt : null,
      lastInbound: this.lastInboundType,
      heartbeatsSent: this.heartbeatsSent,
      messagesReceived: this.messagesReceived,
      videoAttached: this.video !== null,
      heartbeatTimer: this.heartbeatTimer !== null,
      hidden: doc ? doc.hidden : null,
      focused: doc && typeof doc.hasFocus === 'function' ? doc.hasFocus() : null,
      ...(transport.debugInfo ? transport.debugInfo() : {}),
    };

    const line = `[ruyah §8] ${new Date().toISOString()} ${JSON.stringify(fields)}`;
    this.dropoutLog.push(line);
    if (this.dropoutLog.length > 60) this.dropoutLog.shift();
    console.warn(line);
  }

  /**
   * The §8 log, for pasting somewhere after the fact. Reachable from the
   * console as `__ruyah.dropoutReport()` — see the constructor.
   */
  dropoutReport(): string {
    return this.dropoutLog.join('\n');
  }

  private onPeerReturned(): void {
    this.recordDropoutEvent('recovered', { via: this.lastInboundType });
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
      this.peerRttMs = 0;
      this.peerLossRate = 0;
      this.suspectProbes = 0;
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
