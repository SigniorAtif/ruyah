/**
 * A `<video>` that exists entirely on the fake clock.
 *
 * `currentTime` advances at `playbackRate` while playing, driven by the same
 * `advance()` the tests use to move timers, so a 2% nudge over ten seconds is
 * measurable rather than mocked. Every write to `currentTime` is recorded: a
 * seek is the one correction the engine is supposed to avoid, so the tests
 * assert on the list rather than on the final position.
 */

export interface SeekRecord {
  /** Where it was seeked to. */
  to: number;
  /** Where it was before, so a rewind is distinguishable from a jump forward. */
  from: number;
  /** Fake-clock time of the write. */
  at: number;
}

type Listener = (ev: unknown) => void;

export class FakeVideo {
  paused = true;
  playbackRate = 1;
  volume = 1;
  muted = false;
  duration = 7_200;
  readyState = 4;
  /** Every write to currentTime, in order. */
  readonly seeks: SeekRecord[] = [];
  /** Rejection for the next play(), for the autoplay-refusal path. */
  playRejection: Error | null = null;

  private time = 0;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.seeks.push({ to: value, from: this.time, at: this.clock() });
    this.time = value;
    this.emit('seeked');
  }

  /**
   * Put the film somewhere without it counting as a scrub.
   *
   * Writing `currentTime` fires `seeked`, which the engine reads as the person
   * dragging the scrubber and broadcasts — correct behaviour, and not what a
   * test means when it is only arranging a starting position.
   */
  place(position: number): void {
    this.time = position;
  }

  /** Advance the film by `ms` of wall time, honouring rate and paused state. */
  tick(ms: number): void {
    if (this.paused) return;
    this.time = Math.min(this.duration, this.time + (ms / 1000) * this.playbackRate);
  }

  play(): Promise<void> {
    if (this.playRejection) {
      const err = this.playRejection;
      this.playRejection = null;
      return Promise.reject(err);
    }
    this.paused = false;
    this.emit('play');
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.emit('pause');
  }

  // ---- event plumbing the engine wires up in attach()

  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  /** Fire an event as the browser would — used for native play/pause/seeked. */
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type });
  }

  /** Track lists are live objects the engine subscribes to; empty is enough. */
  readonly textTracks = emptyTrackList();
  readonly audioTracks = emptyTrackList();
}

function emptyTrackList() {
  return {
    length: 0,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
}

/** The engine only ever touches the surface above; the cast is the whole point. */
export function asVideoElement(v: FakeVideo): HTMLVideoElement {
  return v as unknown as HTMLVideoElement;
}
