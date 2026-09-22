'use client';

/**
 * Session state (spec §2: sync state lives here, never in component useState).
 *
 * The transport and the engine are held as module singletons rather than in the
 * reactive store: they are identity-stable objects with their own lifecycles,
 * and they must survive the client-side navigation from the lobby to the room.
 * That same navigation is why the file lives here too — a File cannot be put in
 * a URL, and §8 is emphatic that nobody should ever have to re-pick it.
 */

import { create } from 'zustand';
import { WebSocketTransport } from './sync/websocketTransport';
import { MockTransport } from './sync/mockTransport';
import { SimulatedWebSocketTransport } from './sync/simulatedTransport';
import { PlayerEngine, type EngineStatus } from './player/engine';
import { prefetchPreferredAudio, prepareSubtitles, releaseFile } from '@/lib/player/audioTracks';
import { fingerprintFile } from './player/fingerprint';
import type {
  NetworkConditions,
  SyncErrorCode,
  SyncMessage,
  SyncTransport,
  TransportState,
} from './sync/types';
import { isSimulatedTransport } from './sync/types';
import {
  clearLastRoom,
  isDevMode,
  saveDisplayName,
  saveLastRoom,
  saveRelayUrl,
  validateRelayUrl,
} from './relayConfig';
import { clampBurst, isKnownEmoji } from './emoji';

/** No I/O/0/1 — these get read aloud over the phone. */
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const METADATA_TIMEOUT_MS = 15_000;

export function randomRoomCode(): string {
  let out = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return out;
}

/**
 * The wire has no display-name field (§10), and `ready.userId` is the only
 * identity that crosses. So the name rides inside the id, which is what lets
 * §8's overlay say "waiting for Yasmin" instead of "waiting for peer".
 */
function makeUserId(displayName: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${displayName.replace(/#/g, '')}#${suffix}`;
}

/**
 * Identity has to survive a reload (server spec §3).
 *
 * The relay pins authority to a userId, so a creator who refreshes must come
 * back as the same person or they return to their own room as a follower.
 * sessionStorage, not localStorage: this is scoped to one tab and one sitting,
 * which is exactly the lifetime of a room. It is keyed by room code so two
 * rooms in one tab cannot collide.
 *
 * A changed display name deliberately mints a new id — the name rides inside
 * the id and the peer reads it on screen, so a stale one is worse than a lost
 * seat. The server's no-authority promotion is what recovers the room in that
 * case.
 */
function sessionUserId(roomCode: string, displayName: string, preferred?: string): string {
  const key = `ruyah:user:${roomCode}`;
  // A rejoin brings the id it had, so the relay hands back the same seat.
  if (preferred && preferred.split('#')[0] === displayName) {
    try {
      sessionStorage.setItem(key, preferred);
    } catch {
      /* as below */
    }
    return preferred;
  }
  try {
    const stored = sessionStorage.getItem(key);
    if (stored && stored.split('#')[0] === displayName) return stored;
  } catch {
    // Private mode, or storage disabled. A fresh id still works; only the
    // authority-across-reload guarantee is lost.
  }
  const fresh = makeUserId(displayName);
  try {
    sessionStorage.setItem(key, fresh);
  } catch {
    /* as above */
  }
  return fresh;
}

export function nameOf(userId: string | null): string {
  if (!userId) return 'your partner';
  const name = userId.split('#')[0]?.trim();
  return name && name.length > 0 ? name : 'your partner';
}

/** What the chat input allows, and what an incoming line is cut to. */
export const CHAT_MAX_CHARS = 180;
/** Older lines fall off; this is an aside, not a transcript. */
const CHAT_KEEP = 200;
/** How long a line shows over the film in fullscreen, where the aside is hidden. */
const CHAT_TOAST_MS = 5_400;
let chatSeq = 0;
/** How much of a replied-to line travels with the reply. */
const QUOTE_CHARS = 90;
/** The quick row of reactions; the full set, and what arrivals are checked against, is in ./emoji. */
export const REACTIONS = ['😂', '😭', '🥺', '🥹', '🫦', '💝'] as const;
/** Quick row or full set: the only reactions sent, and the only ones shown when they arrive. */
function isReaction(text: string): boolean {
  return (REACTIONS as readonly string[]).includes(text) || isKnownEmoji(text);
}
/** How long a reaction floats over the film. */
const REACTION_MS = 2_600;
/** Gap between the copies of a held reaction, so a burst streams up rather than stacking. */
const BURST_GAP_MS = 70;
/** On screen at once, across both people; enough for two full bursts. */
const REACTIONS_ON_SCREEN = 32;
/** A typing notice lapses on its own if the next one never comes. */
const TYPING_LAPSE_MS = 4_000;

export interface ChatMessage {
  id: number;
  /** Shared by both sides; what a reply points at. */
  wireId: string;
  mine: boolean;
  text: string;
  /** Film time when the sender started typing, or null from a peer that did not send one. */
  position: number | null;
  /** A line marking a hold-on pause, drawn as a note rather than a bubble. */
  hold?: boolean;
  reply?: { wireId: string; text: string; mine: boolean } | null;
}

/** A reaction as it happened in the film, kept for the session: the seek bar's marks. */
export interface ReactionMoment {
  emoji: string;
  mine: boolean;
  /** Film time it was sent at, seconds. */
  position: number;
  /** Copies in the burst; one for a tap. */
  count: number;
}

/** The session's reactions are few, but a long film with a lot of bursts is bounded here. */
const MOMENTS_KEEP = 2_000;

export interface FloatingReaction {
  id: number;
  emoji: string;
  mine: boolean;
  /** Copies in the burst this one came with; big bursts scatter instead of rising. */
  burst: number;
  /** Where it appears, as % of the stage from the left and from the bottom. */
  x: number;
  y: number;
}

/** Bursts bigger than this scatter over the whole screen and rock in place. */
export const SCATTER_ABOVE = 7;

/** Picked once, when it is pushed, so a re-render never moves one. */
function reactionSpot(burst: number): { x: number; y: number } {
  const x = 6 + Math.random() * 88;
  // A small burst rises from the bottom 15%; a big one lands anywhere.
  const y = burst > SCATTER_ABOVE ? 8 + Math.random() * 78 : Math.random() * 15;
  return { x, y };
}

function wireId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
}

/** Transient on-screen feedback; the control bar is usually hidden. */
const TOAST_MS = 1_400;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let typingTimer: ReturnType<typeof setTimeout> | null = null;
let reactionSeq = 0;
let toastSeq = 0;

let transport: SyncTransport | null = null;
let engine: PlayerEngine | null = null;
let unsubscribers: Array<() => void> = [];

export const getTransport = (): SyncTransport | null => transport;
export const getEngine = (): PlayerEngine | null => engine;

export type FingerprintStatus = 'idle' | 'hashing' | 'ready' | 'error';

interface RuyaState {
  // --- session
  roomCode: string;
  displayName: string;
  userId: string;
  isAuthority: boolean;
  transportState: TransportState;
  peerPresent: boolean;

  // --- my file
  file: File | null;
  objectUrl: string | null;
  duration: number;
  fileError: string | null;
  fingerprint: string | null;
  fingerprintStatus: FingerprintStatus;

  // --- readiness
  selfReady: boolean;
  peerReady: boolean;
  peerUserId: string | null;
  peerFingerprint: string | null;

  // --- playback, mirrored out of the engine
  status: EngineStatus | null;
  network: NetworkConditions | null;
  toast: { id: number; text: string } | null;

  // --- chat
  messages: ChatMessage[];
  chatOpen: boolean;
  /** Lines that arrived while the aside was collapsed or the film fullscreen. */
  unread: number;
  /** Lines floated over the film while the aside is collapsed or fullscreen hides it. */
  chatToasts: ChatMessage[];
  /**
   * A clicked toast is on its way into the aside: the toasts stay put until
   * the aside has opened, so there is something to fly from.
   */
  chatHandoffPending: boolean;
  /** The other person is writing something. */
  peerTyping: boolean;
  reactions: FloatingReaction[];
  /** Every reaction this session, both sides, with where in the film it was. */
  moments: ReactionMoment[];
  /** A hold-on pause in force, and who asked for it. Cleared on the next play. */
  hold: { mine: boolean; reason: string } | null;
  /**
   * Lines that arrived by flying in from a toast. They keep a separate key
   * from then on, so they are not remounted and re-animated later.
   */
  chatLanded: number[];

  /**
   * Why the last attempt to join failed. A toast is not enough for these: the
   * person has to read the reason, fix the address, and try again, which means
   * it has to stay on screen next to the field they are fixing.
   */
  sessionError: { code: SyncErrorCode; message: string } | null;

  startSession(opts: {
    roomCode: string;
    displayName: string;
    isAuthority: boolean;
    /** Runtime relay endpoint. Empty selects the mock, in dev mode only. */
    relayUrl: string;
    /** Rejoining: the id used last time, for the same seat and authority. */
    userId?: string;
  }): Promise<void>;
  setFile(file: File): Promise<void>;
  setReady(ready: boolean): void;
  ensureEngine(): PlayerEngine | null;
  /** §8 — re-open a transport that has given up. See the action for why. */
  reconnect(): Promise<void>;
  showToast(text: string): void;
  sendChat(text: string, opts?: { position?: number; replyTo?: string }): void;
  /** Tell the other side we are typing (throttled by the caller). */
  sendTyping(): void;
  /** `count` above one is a held reaction; clamped to MAX_BURST. */
  sendReaction(emoji: string, count?: number): void;
  /** Pause for both, with a reason the other person sees. */
  holdOn(reason: string): void;
  setChatOpen(open: boolean): void;
  setNetwork(patch: Partial<NetworkConditions>): void;
  leave(): void;
  /** Leave on purpose: also forget the room, so the lobby stops offering it. */
  leaveRoom(): void;
}

/** Everything in the store that is session state rather than an action. */
type SessionData = Omit<
  RuyaState,
  | 'startSession'
  | 'setFile'
  | 'setReady'
  | 'ensureEngine'
  | 'showToast'
  | 'setNetwork'
  | 'sendChat'
  | 'sendTyping'
  | 'sendReaction'
  | 'holdOn'
  | 'setChatOpen'
  | 'reconnect'
  | 'leave'
  | 'leaveRoom'
>;

/**
 * The empty session, in one place.
 *
 * `leave()` used to enumerate the fields it cleared by hand and drifted from
 * this list: it left `roomCode` and `isAuthority` set, so leaving a room
 * re-rendered the same room screen with a stale "hosting" badge and no
 * transport behind it. Resetting from a shared constant is what stops that
 * happening again the next time a field is added.
 */
const EMPTY_SESSION: SessionData = {
  roomCode: '',
  displayName: '',
  userId: '',
  isAuthority: false,
  transportState: 'disconnected',
  peerPresent: false,

  file: null,
  objectUrl: null,
  duration: 0,
  fileError: null,
  fingerprint: null,
  fingerprintStatus: 'idle',

  selfReady: false,
  peerReady: false,
  peerUserId: null,
  peerFingerprint: null,

  status: null,
  network: null,
  toast: null,

  messages: [],
  chatOpen: true,
  unread: 0,
  chatToasts: [],
  chatHandoffPending: false,
  peerTyping: false,
  reactions: [],
  moments: [],
  hold: null,
  chatLanded: [],

  sessionError: null,
};

/**
 * Adds a line to the aside. If the aside is collapsed, or fullscreen has
 * hidden it, the line also counts as unread and floats over the film.
 */
function pushChat(
  set: (fn: (s: RuyaState) => Partial<RuyaState>) => void,
  msg: ChatMessage,
): void {
  const fullscreen = typeof document !== 'undefined' && !!document.fullscreenElement;
  set((s) => {
    const hidden = !msg.mine && (!s.chatOpen || fullscreen);
    return {
      messages: [...s.messages, msg].slice(-CHAT_KEEP),
      unread: hidden ? s.unread + 1 : s.unread,
      chatToasts: hidden ? [...s.chatToasts, msg].slice(-3) : s.chatToasts,
    };
  });
  // Harmless when it was never shown: the filter finds nothing.
  if (!msg.mine) {
    setTimeout(
      () => set((s) => ({ chatToasts: s.chatToasts.filter((t) => t.id !== msg.id) })),
      CHAT_TOAST_MS,
    );
  }
}

/**
 * What a reply points at. The line itself when we have it; otherwise the copy
 * that travelled with it, for a line said before we joined or long scrolled off.
 */
function resolveReply(
  messages: ChatMessage[],
  replyTo: unknown,
  quote: unknown,
): ChatMessage['reply'] {
  if (typeof replyTo !== 'string') return null;
  const found = messages.find((m) => m.wireId === replyTo);
  if (found) return { wireId: found.wireId, text: found.text, mine: found.mine };
  if (typeof quote !== 'string' || !quote.trim()) return null;
  // Not in our list, so it can only have been ours if we sent it earlier; the
  // safe reading is theirs.
  return { wireId: replyTo, text: quote.slice(0, QUOTE_CHARS), mine: false };
}

/** Float a reaction over the film for a moment, on this side; a burst streams `count` of them. */
function pushReaction(
  set: (fn: (s: RuyaState) => Partial<RuyaState>) => void,
  emoji: string,
  mine: boolean,
  count = 1,
): void {
  const float = () => {
    const id = ++reactionSeq;
    const spot = reactionSpot(count);
    set((s) => ({
      reactions: [...s.reactions, { id, emoji, mine, burst: count, ...spot }].slice(-REACTIONS_ON_SCREEN),
    }));
    setTimeout(() => set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })), REACTION_MS);
  };
  float();
  for (let i = 1; i < count; i++) setTimeout(float, i * BURST_GAP_MS);
}

function logMoment(
  set: (fn: (s: RuyaState) => Partial<RuyaState>) => void,
  moment: ReactionMoment,
): void {
  set((s) => ({ moments: [...s.moments, moment].slice(-MOMENTS_KEEP) }));
}

export const useRuya = create<RuyaState>((set, get) => ({
  ...EMPTY_SESSION,

  async startSession({ roomCode, displayName, isAuthority, relayUrl, userId: rejoinAs }) {
    get().leave();

    const trimmed = relayUrl.trim();
    const devMode = isDevMode();

    // Empty + dev flag is the only way to reach the mock. Without the flag an
    // empty field is a mistake, not a request for BroadcastChannel — silently
    // running the mock in production would look like a relay that works and
    // then never sees the other person.
    const useMock = __RUYAH_DEV_TOOLS__ && trimmed === '' && devMode;

    if (!useMock) {
      const check = validateRelayUrl(trimmed, devMode);
      if (!check.ok) {
        set({
          sessionError: {
            code: 'invalid_url',
            message: check.message ?? 'That relay address is not usable.',
          },
        });
        return;
      }
    }
    // Persisted even when empty. Empty is a real choice — it selects the mock in
    // dev mode — and not storing it meant a second tab fell back to the default
    // relay and tried to reach the internet while the first was on the mock, so
    // the two never met.
    saveRelayUrl(trimmed);
    // Remembered so the lobby does not ask for it again next visit.
    saveDisplayName(displayName);

    const userId = sessionUserId(roomCode, displayName, rejoinAs);
    // §7.2's authority. Over BroadcastChannel the lobby's choice is the only
    // source of truth; against a relay the server assigns it, and `isAuthority`
    // below is corrected from the `joined` answer.
    // A build without dev tools only ever gets the plain relay transport; the
    // other two are dropped from it along with their imports (lib/devTools.d.ts).
    const t: SyncTransport = !__RUYAH_DEV_TOOLS__
      ? new WebSocketTransport({ url: trimmed })
      : useMock
        ? new MockTransport({ isAuthority })
        : new SimulatedWebSocketTransport({ url: trimmed });
    transport = t;

    unsubscribers.push(
      t.on((msg: SyncMessage) => {
        if (msg.type !== 'chat') return;
        // Relayed verbatim, so nothing upstream has checked the shape.
        if (typeof msg.text !== 'string') return;
        const kind = msg.kind ?? 'text';
        if (kind === 'typing') {
          set({ peerTyping: true });
          if (typingTimer !== null) clearTimeout(typingTimer);
          typingTimer = setTimeout(() => set({ peerTyping: false }), TYPING_LAPSE_MS);
          return;
        }
        if (kind === 'reaction') {
          if (!isReaction(msg.text)) return;
          const count = clampBurst(msg.count);
          pushReaction(set, msg.text, false, count);
          if (Number.isFinite(msg.position)) {
            logMoment(set, { emoji: msg.text, mine: false, position: msg.position as number, count });
          }
          return;
        }
        const text = msg.text.trim().slice(0, CHAT_MAX_CHARS);
        if (!text) return;
        // Whatever they were typing has arrived.
        if (typingTimer !== null) clearTimeout(typingTimer);
        set({ peerTyping: false });
        const position = Number.isFinite(msg.position) ? (msg.position as number) : null;
        if (kind === 'hold') set({ hold: { mine: false, reason: text } });
        pushChat(set, {
          id: ++chatSeq,
          wireId: typeof msg.id === 'string' ? msg.id.slice(0, 24) : wireId(),
          mine: false,
          text,
          position,
          hold: kind === 'hold',
          reply: resolveReply(get().messages, msg.replyTo, msg.quote),
        });
      }),
    );
    unsubscribers.push(
      t.on((msg: SyncMessage) => {
        if (msg.type !== 'ready') return;
        set({
          peerReady: true,
          peerUserId: msg.userId,
          peerFingerprint: msg.fingerprint,
        });
      }),
    );
    unsubscribers.push(t.onStateChange((transportState) => set({ transportState })));
    unsubscribers.push(
      t.onAuthorityChange((nowAuthority) => {
        set({ isAuthority: nowAuthority });
        // Not silent, per §3: the person is now the one correcting, and the
        // sync indicator's role readout alone is too quiet to notice.
        get().showToast(
          nowAuthority ? 'You are now the timing authority' : 'You are now following',
        );
      }),
    );
    unsubscribers.push(
      t.onError((code, message) => {
        set({
          sessionError: {
            code,
            message:
              code === 'room_full'
                ? 'That room already has two people in it.'
                : message,
          },
        });
      }),
    );
    unsubscribers.push(
      t.onPeerPresence((peerPresent, peerId) => {
        set({ peerPresent, peerUserId: peerId ?? get().peerUserId });
        if (!peerPresent) {
          set({ peerReady: false, peerFingerprint: null });
          return;
        }
        // They just arrived and missed whatever we already announced.
        const { selfReady, fingerprint } = get();
        if (selfReady && fingerprint) {
          t.send({ type: 'ready', userId: get().userId, fingerprint });
        }
      }),
    );

    set({
      roomCode,
      displayName,
      userId,
      isAuthority,
      transportState: 'connecting',
      network: isSimulatedTransport(t) ? t.getNetwork() : null,
    });

    await t.connect(roomCode, userId);

    // A fatal failure (bad address, nothing listening, room full) must drop the
    // whole session rather than leave a room screen sitting in front of a
    // transport that will never connect. leave() clears sessionError, so the
    // reason is re-applied after it.
    const failure = get().sessionError;
    if (failure) {
      get().leave();
      set({ sessionError: failure });
      return;
    }

    // The relay decides who holds authority and its answer outranks the lobby's
    // assumption — a creator rejoining a room they already own, or a joiner
    // landing in an empty one, both come back different from what was clicked.
    set({ transportState: t.state, isAuthority: t.isAuthority });
    saveLastRoom({ code: roomCode, relayUrl: trimmed, displayName, userId, at: Date.now() });
  },

  async setFile(file) {
    const previousFile = get().file;
    if (previousFile && previousFile !== file) releaseFile(previousFile);
    const previous = get().objectUrl;
    // §12: revoke or the file's memory mapping leaks.
    if (previous) URL.revokeObjectURL(previous);

    const objectUrl = URL.createObjectURL(file);
    set({
      file,
      objectUrl,
      duration: 0,
      fileError: null,
      fingerprint: null,
      fingerprintStatus: 'hashing',
      selfReady: false,
    });

    // §12: wait for loadedmetadata before allowing ready — we need duration —
    // and catch containers Chrome can't decode rather than showing a black
    // rectangle later.
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    const meta = new Promise<void>((resolve) => {
      const done = (error: string | null, duration: number) => {
        clearTimeout(timer);
        probe.removeAttribute('src');
        probe.load();
        set({ duration, fileError: error });
        resolve();
      };
      const timer = setTimeout(
        () =>
          done(
            'That file took too long to open. It may use a codec your browser cannot decode.',
            0,
          ),
        METADATA_TIMEOUT_MS,
      );
      probe.onloadedmetadata = () => done(null, probe.duration);
      probe.onerror = () =>
        done(
          'Your browser cannot decode this file — often HEVC video or AC3 audio in an .mp4 container. Try a different encode.',
          0,
        );
    });
    probe.src = objectUrl;
    await meta;
    // Start pulling out the preferred audio language now, while the room waits,
    // so it is usually ready by the time the film starts.
    if (!get().fileError) {
      void prefetchPreferredAudio(file, get().duration);
      // Likewise the subtitle text; the player picks the result up when it opens.
      const duration = get().duration;
      prepareSubtitles(file, () => duration).promise.catch(() => {});
    }

    try {
      const fingerprint = await fingerprintFile(file);
      set({ fingerprint, fingerprintStatus: 'ready' });
    } catch {
      set({ fingerprintStatus: 'error' });
    }
  },

  setReady(ready) {
    const { fingerprint } = get();
    set({ selfReady: ready });
    if (ready && fingerprint && transport) {
      transport.send({ type: 'ready', userId: get().userId, fingerprint });
    }
  },

  ensureEngine() {
    if (!transport) return null;
    if (engine) return engine;
    engine = new PlayerEngine({ transport });
    // Playback state is mirrored into the store so components stay dumb (§3).
    unsubscribers.push(
      engine.subscribe((status) => {
        // A hold lasts until someone presses play again: a paused-to-playing
        // edge, not just "playing", because the hold's own pause is scheduled
        // a moment ahead and the film is still running when it is asked for.
        const resumed = status.playing && get().status?.playing === false;
        if (resumed && get().hold) set({ status, hold: null });
        else set({ status });
      }),
    );
    return engine;
  },

  showToast(text) {
    toastSeq += 1;
    set({ toast: { id: toastSeq, text } });
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      set({ toast: null });
    }, TOAST_MS);
  },

  sendChat(raw, opts = {}) {
    const text = raw.trim().slice(0, CHAT_MAX_CHARS);
    if (!text || !transport) return;
    // Stamped with when they started typing, which is the moment they mean;
    // by the time they hit enter the film has moved on.
    const position = opts.position ?? engine?.getStatus().position ?? 0;
    const id = wireId();
    const replied = opts.replyTo
      ? get().messages.find((m) => m.wireId === opts.replyTo)
      : undefined;
    transport.send({
      type: 'chat',
      userId: get().userId,
      text,
      at: transport.syncedNow(),
      position,
      id,
      ...(replied ? { replyTo: replied.wireId, quote: replied.text.slice(0, QUOTE_CHARS) } : {}),
    });
    pushChat(set, {
      id: ++chatSeq,
      wireId: id,
      mine: true,
      text,
      position,
      reply: replied ? { wireId: replied.wireId, text: replied.text, mine: replied.mine } : null,
    });
  },

  sendTyping() {
    if (!transport) return;
    transport.send({
      type: 'chat',
      userId: get().userId,
      text: '',
      at: transport.syncedNow(),
      kind: 'typing',
    });
  },

  sendReaction(emoji, count = 1) {
    if (!transport || !isReaction(emoji)) return;
    const burst = clampBurst(count);
    const position = engine?.getStatus().position ?? 0;
    transport.send({
      type: 'chat',
      userId: get().userId,
      text: emoji,
      at: transport.syncedNow(),
      position,
      kind: 'reaction',
      ...(burst > 1 && { count: burst }),
    });
    pushReaction(set, emoji, true, burst);
    logMoment(set, { emoji, mine: true, position, count: burst });
  },

  holdOn(raw) {
    const reason = raw.trim().slice(0, CHAT_MAX_CHARS) || 'hold on';
    if (!transport) return;
    // An ordinary pause, so it reaches both players through the engine; the
    // reason travels beside it as a chat line.
    if (engine?.getStatus().playing) engine.pause();
    const position = engine?.getStatus().position ?? 0;
    const id = wireId();
    transport.send({
      type: 'chat',
      userId: get().userId,
      text: reason,
      at: transport.syncedNow(),
      position,
      id,
      kind: 'hold',
    });
    set({ hold: { mine: true, reason } });
    pushChat(set, { id: ++chatSeq, wireId: id, mine: true, text: reason, position, hold: true });
  },

  setChatOpen(open) {
    // Opening the aside shows every line, so the floating copies go.
    set((s) => ({
      chatOpen: open,
      unread: open ? 0 : s.unread,
      chatToasts:
        open && !document.fullscreenElement && !s.chatHandoffPending ? [] : s.chatToasts,
    }));
  },

  /**
   * Ask the transport to connect again after it has stopped trying.
   *
   * `reconnecting` retries on its own, but `disconnected` is terminal: a fatal
   * close (room full, rate limited, replaced) or a pulled cable leaves the
   * socket shut with no backoff running, and nothing in the UI could reopen it.
   * The only way out was a reload, which throws away the loaded File — the one
   * thing §8 promises to keep. `connect()` clears the fatal and closed flags,
   * so this is all it takes.
   */
  async reconnect() {
    const { roomCode, userId } = get();
    if (!transport || !roomCode || !userId) return;
    set({ sessionError: null });
    await transport.connect(roomCode, userId);
  },

  setNetwork(patch) {
    if (!transport || !isSimulatedTransport(transport)) return;
    transport.setNetwork(patch);
    set({ network: transport.getNetwork() });
  },

  leaveRoom() {
    clearLastRoom();
    get().leave();
  },

  leave() {
    for (const un of unsubscribers) un();
    unsubscribers = [];
    engine?.destroy();
    engine = null;
    transport?.disconnect();
    transport = null;
    const url = get().objectUrl;
    if (url) URL.revokeObjectURL(url);
    const file = get().file;
    if (file) releaseFile(file);
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = null;
    if (typingTimer !== null) clearTimeout(typingTimer);
    typingTimer = null;
    // Clearing roomCode is what actually returns to the lobby: Lobby renders
    // the room screen while it is set, and VideoPlayer routes back to '/' when
    // it no longer matches the URL (or the object URL is gone).
    set({ ...EMPTY_SESSION });
  },
}));

/** True only when both sides hold the same encode (§9). */
export function fingerprintsMatch(mine: string | null, theirs: string | null): boolean | null {
  if (!mine || !theirs) return null;
  return mine === theirs;
}
