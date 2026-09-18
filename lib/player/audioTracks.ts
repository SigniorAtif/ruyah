/**
 * Audio-language switching for browsers that cannot do it themselves.
 *
 * Safari exposes `video.audioTracks` and switches natively; the engine uses
 * that when it exists. Chromium (Chrome, Brave, Edge) always plays a file's
 * first audio track. There, the chosen track is extracted (see extractAudio)
 * and played from a hidden <audio> element slaved to the <video>, whose own
 * sound is muted. The <video> stays the only clock the sync engine sees.
 *
 * All of this is local, like volume: each person hears their own language.
 */

import { AbortedError, extractAudioTrack } from './extractAudio';
import { browserPlays, primaryLanguage, probeAudioTracks, type ProbedAudioTrack } from './probe';

const PREFERRED_LANGUAGE_KEY = 'ruya.audioLanguage';
const DEFAULT_LANGUAGE = 'en';

export function nativeAudioSwitching(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'audioTracks' in HTMLMediaElement.prototype;
}

export function preferredLanguage(): string {
  try {
    return localStorage.getItem(PREFERRED_LANGUAGE_KEY) || DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function rememberLanguage(tag: string): void {
  const lang = primaryLanguage(tag);
  if (!lang) return;
  try {
    localStorage.setItem(PREFERRED_LANGUAGE_KEY, lang);
  } catch {
    // Private window or blocked storage: the choice just won't carry over.
  }
}

/** The track to play for `lang`, preferring ones that need no conversion. */
export function pickTrack(tracks: ProbedAudioTrack[], lang: string): ProbedAudioTrack | null {
  if (!tracks.length) return null;
  const wanted = primaryLanguage(lang);
  let named = '';
  try {
    named = new Intl.DisplayNames(['en'], { type: 'language' }).of(wanted)?.toLowerCase() ?? '';
  } catch {
    // fall through with no name match
  }
  const score = (t: ProbedAudioTrack) => {
    const matches =
      primaryLanguage(t.language) === wanted || (!!named && t.name.toLowerCase().includes(named));
    if (!matches) return -1;
    let s = 8;
    if (!/comment/i.test(t.name)) s += 4; // the film, not the director talking over it
    if (browserPlays(t.codec)) s += 2;
    if (t.isDefault) s += 1;
    return s;
  };
  let best: ProbedAudioTrack | null = null;
  let bestScore = -1;
  for (const t of tracks) {
    const s = score(t);
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return best;
}

// ------------------------------------------------------------ shared jobs

/**
 * Extractions are shared and cached per file and track, so work started while
 * picking the file in the room screen is picked up by the player later.
 */
interface Job {
  promise: Promise<string>;
  /** 0..1. */
  progress: number;
  /**
   * The film's length, for progress. Settable because the player may know it
   * before the room screen's probe does, or the other way round.
   */
  durationSec: number;
  abort: AbortController;
  listeners: Set<() => void>;
  url: string | null;
}

const jobs = new Map<string, Job>();
const probes = new WeakMap<File, Promise<ProbedAudioTrack[]>>();

function keyOf(file: File, index: number) {
  return `${file.name}\0${file.size}\0${file.lastModified}\0${index}`;
}

export function probeCached(file: File): Promise<ProbedAudioTrack[]> {
  let p = probes.get(file);
  if (!p) {
    p = probeAudioTracks(file).catch(() => []);
    probes.set(file, p);
  }
  return p;
}

function prepareTrack(file: File, track: ProbedAudioTrack, durationSec: number): Job {
  const key = keyOf(file, track.index);
  const existing = jobs.get(key);
  if (existing) {
    if (durationSec > 0) existing.durationSec = durationSec;
    return existing;
  }

  // One ffmpeg at a time: a newer choice outranks an unfinished older one.
  const prefix = keyOf(file, -1).slice(0, -2);
  for (const [k, j] of jobs) {
    if (k.startsWith(prefix) && !j.url) {
      j.abort.abort();
      jobs.delete(k);
    }
  }

  const abort = new AbortController();
  const job: Job = {
    progress: 0,
    durationSec,
    abort,
    listeners: new Set(),
    url: null,
    promise: Promise.resolve(''),
  };
  job.promise = extractAudioTrack(
    file,
    track.index,
    track.codec,
    (seconds) => {
      if (job.durationSec <= 0) return;
      job.progress = Math.min(1, Math.max(0, seconds / job.durationSec));
      for (const fn of job.listeners) fn();
    },
    abort.signal,
  ).then(
    (blob) => {
      job.url = URL.createObjectURL(blob);
      return job.url;
    },
    (err) => {
      jobs.delete(key);
      throw err;
    },
  );
  jobs.set(key, job);
  return job;
}

/**
 * Start extracting the preferred-language track as soon as a file is picked,
 * if this browser will need it. Fire and forget.
 */
export async function prefetchPreferredAudio(file: File, durationSec: number): Promise<void> {
  if (nativeAudioSwitching()) return;
  const tracks = await probeCached(file);
  const target = initialTrack(tracks);
  if (target && (target.index !== 0 || !browserPlays(target.codec))) {
    prepareTrack(file, target, durationSec).promise.catch(() => {});
  }
}

/** What a newly opened file should play: preferred language, else the first playable track. */
function initialTrack(tracks: ProbedAudioTrack[]): ProbedAudioTrack | null {
  return (
    pickTrack(tracks, preferredLanguage()) ??
    (tracks[0] && browserPlays(tracks[0].codec) ? tracks[0] : null) ??
    tracks.find((t) => browserPlays(t.codec)) ??
    tracks[0] ??
    null
  );
}

/** Drop everything extracted for a file that is no longer in use. */
export function releaseFile(file: File): void {
  const prefix = keyOf(file, -1).slice(0, -2);
  for (const [k, j] of jobs) {
    if (!k.startsWith(prefix)) continue;
    j.abort.abort();
    if (j.url) URL.revokeObjectURL(j.url);
    jobs.delete(k);
  }
}

// --------------------------------------------------------------- follower

/** Beyond this, jump the audio; below it, steer it with playbackRate. */
const HARD_SYNC_S = 0.25;
const SOFT_SYNC_S = 0.03;
const MAX_NUDGE = 0.05;

/** Keeps a hidden <audio> on the <video>'s clock. The <video> never waits for it. */
class AudioFollower {
  readonly audio: HTMLAudioElement;
  private readonly offs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly video: HTMLVideoElement,
    src: string,
  ) {
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.src = src;
    this.audio = audio;

    const on = (type: string, fn: () => void) => {
      video.addEventListener(type, fn);
      this.offs.push(() => video.removeEventListener(type, fn));
    };
    on('play', () => this.resync(true));
    on('playing', () => this.resync(true));
    on('pause', () => audio.pause());
    on('waiting', () => audio.pause());
    on('seeking', () => this.jump());
    on('seeked', () => this.resync(true));
    on('ratechange', () => (audio.playbackRate = video.playbackRate));
    // A play started by the other person is not a gesture here, and autoplay
    // policy can refuse the <audio> even while the muted <video> runs. Any
    // click or key on the page unlocks it; retry then.
    // Not a hard resync: that would jump the audio on every key press.
    const unlock = () => this.resync(false);
    for (const type of ['pointerdown', 'keydown'] as const) {
      document.addEventListener(type, unlock, true);
      this.offs.push(() => document.removeEventListener(type, unlock, true));
    }
    this.timer = setInterval(() => this.resync(false), 250);
    this.resync(true);
  }

  private jump() {
    try {
      this.audio.currentTime = this.video.currentTime;
    } catch {
      // not seekable yet; the next tick retries
    }
  }

  private resync(hard: boolean) {
    const { video, audio } = this;
    const running = !video.paused && !video.ended && video.readyState >= 3;
    if (!running) {
      if (!audio.paused) audio.pause();
      if (hard) this.jump();
      return;
    }
    const drift = audio.currentTime - video.currentTime;
    if (hard || Math.abs(drift) > HARD_SYNC_S) {
      this.jump();
      audio.playbackRate = video.playbackRate;
    } else if (Math.abs(drift) > SOFT_SYNC_S) {
      const nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift * 0.5));
      audio.playbackRate = video.playbackRate * (1 - nudge);
    } else {
      audio.playbackRate = video.playbackRate;
    }
    // Rejects only on autoplay policy; the next play press is a gesture.
    if (audio.paused) void audio.play().catch(() => {});
  }

  destroy() {
    clearInterval(this.timer);
    for (const off of this.offs) off();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}

// ------------------------------------------------------------- controller

export interface AudioChoiceStatus {
  tracks: ProbedAudioTrack[];
  /** Track being heard; -1 before the file has been read. */
  active: number;
  preparing: { index: number; progress: number } | null;
  error: string | null;
}

/**
 * One per attached <video>. Owns the follower and the mute state while the
 * video's own sound is off.
 */
export class AudioTrackController {
  private tracks: ProbedAudioTrack[] = [];
  private active = -1;
  private preparing: { index: number; progress: number } | null = null;
  private error: string | null = null;
  private follower: AudioFollower | null = null;
  /** The person's mute, kept here while the <video> itself is forced silent. */
  private userMuted = false;
  private request = 0;
  private disposed = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly file: File,
    private readonly onChange: () => void,
    private readonly onSwitched: (label: string) => void,
  ) {
    void this.init();
  }

  private async init() {
    const tracks = await probeCached(this.file);
    if (this.disposed) return;
    this.tracks = tracks;
    if (!tracks.length) return;
    this.active = 0;
    this.onChange();
    const target = initialTrack(tracks);
    if (target && (target.index !== 0 || !browserPlays(target.codec))) {
      void this.select(target.index, false);
    }
  }

  get external(): boolean {
    return this.follower !== null;
  }

  status(): AudioChoiceStatus {
    return {
      tracks: this.tracks,
      active: this.active,
      preparing: this.preparing,
      error: this.error,
    };
  }

  /** Switch to track `index`. `remember` records its language as the new preference. */
  async select(index: number, remember = true): Promise<void> {
    const track = this.tracks[index];
    if (!track) return;
    if (remember) rememberLanguage(track.language);
    const req = ++this.request;
    this.error = null;

    // The first track is what the browser plays anyway, when it can.
    if (index === 0 && browserPlays(track.codec)) {
      this.preparing = null;
      this.setFollower(null);
      this.active = 0;
      this.onChange();
      return;
    }

    const job = prepareTrack(this.file, track, this.video.duration || 0);
    // Opened before metadata: fill the length in once it arrives.
    if (!(this.video.duration > 0)) {
      this.video.addEventListener(
        'loadedmetadata',
        () => {
          if (this.video.duration > 0) job.durationSec = this.video.duration;
        },
        { once: true },
      );
    }
    const tick = () => {
      if (req !== this.request) return;
      this.preparing = { index, progress: job.progress };
      this.onChange();
    };
    if (!job.url) {
      job.listeners.add(tick);
      tick();
    }
    try {
      const url = await job.promise;
      if (req !== this.request || this.disposed) return;
      this.preparing = null;
      this.setFollower(url);
      this.active = index;
      this.onSwitched(labelOf(track));
    } catch (err) {
      if (req !== this.request || this.disposed || err instanceof AbortedError) return;
      this.preparing = null;
      this.error = 'Could not read that audio track from the file.';
    } finally {
      job.listeners.delete(tick);
      if (req === this.request) this.onChange();
    }
  }

  private setFollower(url: string | null) {
    if (!url) {
      if (this.follower) {
        this.follower.destroy();
        this.follower = null;
        this.video.muted = this.userMuted;
      }
      return;
    }
    if (!this.follower) this.userMuted = this.video.muted;
    this.follower?.destroy();
    this.follower = new AudioFollower(this.video, url);
    this.video.muted = true;
    this.applyOutput();
  }

  /** The person's mute while the follower is playing; the video stays silent. */
  get muted(): boolean {
    return this.userMuted;
  }

  setMuted(muted: boolean) {
    this.userMuted = muted;
    this.applyOutput();
  }

  /** Mirror the video's volume and the person's mute onto the follower. */
  applyOutput() {
    if (!this.follower) return;
    this.follower.audio.volume = this.video.volume;
    this.follower.audio.muted = this.userMuted;
  }

  dispose() {
    this.disposed = true;
    this.request++;
    this.setFollower(null);
  }
}

export function labelOf(t: ProbedAudioTrack): string {
  let lang = '';
  try {
    lang = t.language
      ? (new Intl.DisplayNames(undefined, { type: 'language' }).of(primaryLanguage(t.language)) ?? '')
      : '';
  } catch {
    lang = t.language;
  }
  if (t.name && lang && !t.name.toLowerCase().includes(lang.toLowerCase())) return `${t.name} · ${lang}`;
  return t.name || lang || `Track ${t.index + 1}`;
}
