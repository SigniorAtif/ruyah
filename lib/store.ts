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
import { PlayerEngine, type EngineStatus } from './player/engine';
import { prefetchPreferredAudio, releaseFile } from '@/lib/player/audioTracks';
import { fingerprintFile } from './player/fingerprint';
import type {
  SyncErrorCode,
  SyncMessage,
  SyncTransport,
  TransportState,
} from './sync/types';
import { isDevMode, saveRelayUrl, validateRelayUrl } from './relayConfig';

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
function sessionUserId(roomCode: string, displayName: string): string {
  const key = `ruyah:user:${roomCode}`;
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

export interface ChatMessage {
  id: number;
  mine: boolean;
  text: string;
  /** Sender's film time when it was said, or null from a peer that did not send one. */
  position: number | null;
}

/** Transient on-screen feedback; the control bar is usually hidden. */
const TOAST_MS = 1_400;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
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
    /** Runtime relay endpoint. Always a real wss:// relay. */
    relayUrl: string;
  }): Promise<void>;
  setFile(file: File): Promise<void>;
  setReady(ready: boolean): void;
  ensureEngine(): PlayerEngine | null;
  /** §8 — re-open a transport that has given up. See the action for why. */
  reconnect(): Promise<void>;
  showToast(text: string): void;
  sendChat(text: string): void;
  setChatOpen(open: boolean): void;
  leave(): void;
}

/** Everything in the store that is session state rather than an action. */
type SessionData = Omit<
  RuyaState,
  | 'startSession'
  | 'setFile'
  | 'setReady'
  | 'ensureEngine'
  | 'showToast'
  | 'sendChat'
  | 'setChatOpen'
  | 'reconnect'
  | 'leave'
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
  toast: null,

  messages: [],
  chatOpen: true,
  unread: 0,
  chatToasts: [],
  chatHandoffPending: false,
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

export const useRuya = create<RuyaState>((set, get) => ({
  ...EMPTY_SESSION,

  async startSession({ roomCode, displayName, isAuthority, relayUrl }) {
    get().leave();

    const trimmed = relayUrl.trim();
    const check = validateRelayUrl(trimmed, isDevMode());
    if (!check.ok) {
      set({
        sessionError: {
          code: 'invalid_url',
          message: check.message ?? 'That relay address is not usable.',
        },
      });
      return;
    }
    // Persisted so a second window opens against the same relay rather than
    // falling back to the default and never meeting the first.
    saveRelayUrl(trimmed);

    const userId = sessionUserId(roomCode, displayName);
    // §7.2's authority is the server's to assign; the lobby's `isAuthority` is
    // only a starting guess and is corrected from the `joined` answer.
    const t: SyncTransport = new WebSocketTransport({ url: trimmed });
    transport = t;

    unsubscribers.push(
      t.on((msg: SyncMessage) => {
        if (msg.type !== 'chat') return;
        // Relayed verbatim, so nothing upstream has checked the shape.
        if (typeof msg.text !== 'string') return;
        const text = msg.text.trim().slice(0, CHAT_MAX_CHARS);
        if (!text) return;
        pushChat(set, {
          id: ++chatSeq,
          mine: false,
          text,
          position: Number.isFinite(msg.position) ? (msg.position as number) : null,
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
    if (!get().fileError) void prefetchPreferredAudio(file, get().duration);

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
    unsubscribers.push(engine.subscribe((status) => set({ status })));
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

  sendChat(raw) {
    const text = raw.trim().slice(0, CHAT_MAX_CHARS);
    if (!text || !transport) return;
    const position = engine?.getStatus().position ?? 0;
    transport.send({
      type: 'chat',
      userId: get().userId,
      text,
      at: transport.syncedNow(),
      position,
    });
    pushChat(set, { id: ++chatSeq, mine: true, text, position });
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
