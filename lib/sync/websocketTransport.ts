/**
 * Phase 2 transport (server spec §5).
 *
 * The same SyncTransport the engine already codes against, over a real socket.
 * The server holds rooms and relays; this file holds the socket, the backoff,
 * and the clock — and nothing about video.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *  - The clock runs in `'server'` reference mode (§2). Both sides estimate an
 *    offset to the relay, including the authority. See ClockSync for why.
 *  - The send queue is dropped on disconnect, never replayed (§5). A `play`
 *    scheduled for a moment that has already passed is worse than no play at
 *    all; §8's resync is what recovers, not a backlog flush.
 */

import { ClockSync } from './clock';
import type {
  SyncErrorCode,
  SyncMessage,
  SyncTransport,
  TransportState,
} from './types';

/** §5: 500ms → 8s ceiling, with jitter. */
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const BACKOFF_FACTOR = 2;
/** Fraction of the delay drawn at random, so two clients never march in step. */
const BACKOFF_JITTER = 0.3;

/**
 * How long to wait for a relay to answer before calling it unreachable.
 *
 * The browser will not do this for us: an address that does not resolve, or a
 * host that silently drops the SYN, leaves the socket in CONNECTING for around
 * two minutes before it fires a single close with code 1006. Waiting that out
 * means the lobby sits on a room screen saying nothing, which reads as a hung
 * app. Eight seconds matches §8's dropout feel and is far longer than any real
 * handshake.
 */
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * Server-originated types (server spec §3). They are connection metadata, not
 * playback, and must never reach the engine.
 */
type ServerMessage =
  | { type: 'joined'; userId: string; isAuthority: boolean; roomSize: number }
  | { type: 'peer'; event: 'joined' | 'left'; userId: string }
  | { type: 'error'; code: SyncErrorCode; message: string };

type Incoming = SyncMessage | ServerMessage;

/**
 * Close codes the relay uses (server/protocol.js). A fatal close must not be
 * retried: reconnecting into a full room, or after being replaced by our own
 * newer socket, produces a loop that looks like a network fault and is not one.
 */
const CLOSE_ROOM_FULL = 4001;
const CLOSE_RATE_LIMITED = 4002;
const CLOSE_BAD_MESSAGE = 4003;
const CLOSE_REPLACED = 4004;
const FATAL_CLOSE_CODES = new Set([
  CLOSE_ROOM_FULL,
  CLOSE_RATE_LIMITED,
  CLOSE_BAD_MESSAGE,
  CLOSE_REPLACED,
]);

export interface WebSocketTransportOptions {
  /** Base relay URL, e.g. `ws://localhost:8080/ws` or `wss://host/ws`. */
  url: string;
}

export class WebSocketTransport implements SyncTransport {
  private readonly url: string;

  protected socket: WebSocket | null = null;
  private roomId = '';
  private userId = '';

  private isAuthorityValue = false;
  private peerIdValue: string | null = null;
  protected peerPresentValue = false;
  protected stateValue: TransportState = 'disconnected';

  /** Set while a fatal error has ended the session; blocks all reconnection. */
  protected fatal = false;
  /**
   * Did the current socket complete its handshake, and did the relay answer
   * with `joined`? Together these separate "nothing answered" from "something
   * answered and turned us away", which are different problems on screen.
   *
   * A browser gives almost nothing to work with here: a refused connection, a
   * DNS failure, a TLS failure and an endpoint that is not a WebSocket all
   * arrive as close code 1006 with no reason. What IS reliable is whether
   * `onopen` fired — so that, rather than the close code, is what this splits on.
   */
  private everOpened = false;
  protected everJoined = false;
  protected reportedError: SyncErrorCode | null = null;
  /** True once the caller has asked to be disconnected, so retries stop. */
  protected closedByUs = false;

  protected attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;


  private readonly handlers = new Set<(msg: SyncMessage) => void>();
  private readonly stateHandlers = new Set<(state: TransportState) => void>();
  private readonly presenceHandlers = new Set<
    (present: boolean, peerId: string | null) => void
  >();
  private readonly authorityHandlers = new Set<(isAuthority: boolean) => void>();
  private readonly errorHandlers = new Set<
    (code: SyncErrorCode, message: string) => void
  >();

  protected readonly clock: ClockSync;

  /** Resolves connect() once the room has answered, or once it clearly won't. */
  private settleConnect: (() => void) | null = null;

  constructor(opts: WebSocketTransportOptions) {
    this.url = opts.url;
    this.clock = new ClockSync({
      // Authority is the server's to assign, and in server mode the clock does
      // not care either way — it is passed for completeness, not for timing.
      isAuthority: false,
      reference: 'server',
      send: (msg) => this.send(msg),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  async connect(roomId: string, userId: string): Promise<void> {
    this.disconnect();

    this.roomId = roomId;
    this.userId = userId;
    this.fatal = false;
    this.closedByUs = false;
    this.everOpened = false;
    this.everJoined = false;
    this.reportedError = null;
    this.attempt = 0;
    this.setState('connecting');

    const settled = new Promise<void>((resolve) => {
      this.settleConnect = resolve;
    });
    this.open();

    // Resolving on the first `joined` means the caller knows its role before it
    // gets a transport back. A failed first attempt resolves too, into
    // 'reconnecting' — stranding the lobby on a dead server helps nobody, and
    // §8's overlay is already the right place to explain it.
    await settled;
  }

  disconnect(): void {
    this.closedByUs = true;
    this.clock.stop();
    this.clearRetry();
    this.clearConnectTimer();
    this.teardownSocket();
    this.setPeerPresent(false);
    this.peerIdValue = null;
    this.resolveConnect();
    if (this.stateValue !== 'disconnected') this.setState('disconnected');
  }

  protected open(): void {
    if (this.fatal || this.closedByUs || !this.linkUp()) return;

    const url = `${this.url}?room=${encodeURIComponent(
      this.roomId,
    )}&user=${encodeURIComponent(this.userId)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      // The WebSocket constructor throws synchronously on an address it cannot
      // use at all. Retrying cannot fix a bad address, so this is fatal and
      // explained rather than hidden behind a backoff that never succeeds.
      this.fatal = true;
      this.report(
        'invalid_url',
        'That relay address is not usable. It should look like wss://host/ws',
      );
      this.resolveConnect();
      this.setState('disconnected');
      return;
    }
    this.socket = socket;

    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.socket !== socket || this.everJoined) return;
      // Nothing came back in time. Say which kind of nothing it was, then close
      // so the browser stops waiting on a connection that is not coming.
      if (!this.everOpened) {
        this.report(
          'unreachable',
          'No answer from that relay. Check the address, and that the relay is running and reachable over TLS.',
        );
      } else {
        this.report(
          'rejected',
          'The relay accepted the connection but never answered. Check that the address points at a ruyah relay.',
        );
      }
      this.fatal = true;
      this.teardownSocket();
      this.resolveConnect();
      this.setState('disconnected');
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.everOpened = true;
      this.attempt = 0;
      // §5: the old offset is stale and the path may have changed, so the full
      // 7-sample burst runs again from scratch before anything is scheduled.
      this.clock.reset();
      this.clock.start();
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (this.socket !== socket) return;
      this.onSocketData(ev.data);
    };

    socket.onerror = () => {
      // 'close' always follows; the retry is scheduled from there so it cannot
      // be scheduled twice for the same failure.
    };

    socket.onclose = (ev: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearConnectTimer();
      this.clock.stop();
      this.setPeerPresent(false);

      if (FATAL_CLOSE_CODES.has(ev.code)) {
        this.fatal = true;
        // room_full already arrived as an `error` frame and was reported; the
        // others mean the relay answered and refused us.
        if (ev.code !== CLOSE_ROOM_FULL && !this.reportedError) {
          this.report('rejected', 'The relay refused this connection.');
        }
        this.resolveConnect();
        this.setState('disconnected');
        return;
      }

      // Never got as far as an open socket: there is nothing usable at that
      // address, so say so instead of retrying in silence.
      if (!this.everOpened && !this.reportedError) {
        this.report(
          'unreachable',
          'Could not reach that relay. Check the address, and that the relay is running and reachable over TLS.',
        );
      } else if (this.everOpened && !this.everJoined && !this.reportedError) {
        // The handshake succeeded and then the relay dropped us without ever
        // answering `joined`. Something is listening there, but it is not
        // speaking this protocol — a different service on the same port, or a
        // proxy that upgraded the connection and then gave up.
        this.report(
          'rejected',
          'The relay accepted the connection but did not answer. Check that the address points at a ruyah relay.',
        );
      }
      if (this.closedByUs || !this.linkUp()) {
        this.resolveConnect();
        this.setState('disconnected');
        return;
      }
      this.setState('reconnecting');
      this.scheduleRetry();
    };
  }

  protected teardownSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  }

  /** §5: exponential backoff, 500ms → 8s ceiling, with jitter. */
  private scheduleRetry(): void {
    if (this.fatal || this.closedByUs || !this.linkUp()) return;
    this.clearRetry();

    const base = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_MIN_MS * BACKOFF_FACTOR ** this.attempt,
    );
    const delay = base * (1 - BACKOFF_JITTER + Math.random() * BACKOFF_JITTER);
    this.attempt++;

    // The first failure resolves connect(): the caller is waiting, and the
    // answer "not yet, keep the overlay up" is more useful than a hang.
    this.resolveConnect();

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  protected clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  protected clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private resolveConnect(): void {
    const settle = this.settleConnect;
    this.settleConnect = null;
    settle?.();
  }

  // ------------------------------------------------------------------ sending

  send(msg: SyncMessage): void {
    // §5: never queue across a disconnect. If the socket is not open the
    // message is dropped, silently and on purpose.
    this.writeNow(msg);
  }

  // ------------------------------------------------------------------ hooks
  // Seams for the dev-only network simulator (lib/sync/simulatedTransport.ts),
  // which overrides them in a subclass. Here they are pass-throughs, so a build
  // without dev tools carries none of the simulation.

  /** Whether this client's link is up. A real one always is; the socket says the rest. */
  protected linkUp(): boolean {
    return true;
  }

  /** One frame off the socket, before it is parsed. */
  protected onSocketData(data: unknown): void {
    this.receive(data);
  }

  protected writeNow(msg: SyncMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------- receiving

  protected receive(data: unknown): void {
    if (typeof data !== 'string') return;

    let msg: Incoming;
    try {
      msg = JSON.parse(data) as Incoming;
    } catch {
      return; // the relay validates; a frame we cannot read is not actionable
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'joined':
        this.onJoined(msg);
        return;
      case 'peer':
        this.onPeerEvent(msg);
        return;
      case 'error':
        this.onServerError(msg);
        return;
      default:
        break;
    }

    // ping/pong belongs to the clock and must never reach the engine. In server
    // mode only `pong` arrives; the relay answers our pings itself (§2).
    if (this.clock.handleMessage(msg as SyncMessage)) return;

    for (const handler of this.handlers) handler(msg as SyncMessage);
  }

  private onJoined(msg: ServerMessage & { type: 'joined' }): void {
    this.everJoined = true;
    this.clearConnectTimer();
    const wasAuthority = this.isAuthorityValue;
    this.isAuthorityValue = msg.isAuthority === true;

    this.setState('connected');
    this.resolveConnect();
    // A fresh room answer is the moment to measure, rather than waiting out the
    // burst retry we may have just scheduled against a dead socket.
    this.clock.kick();

    // The server re-sends `joined` when it promotes the remaining member of a
    // room that has been left without an authority. That is a real change of
    // role mid-session and everything gated on it has to hear about it.
    if (wasAuthority !== this.isAuthorityValue) {
      for (const handler of this.authorityHandlers) {
        handler(this.isAuthorityValue);
      }
    }
  }

  private onPeerEvent(msg: ServerMessage & { type: 'peer' }): void {
    if (msg.event === 'joined') {
      this.peerIdValue = msg.userId;
      // Announced every time, not only when presence changes. Someone who
      // reclaims their seat (§3: same userId, e.g. after a refresh) arrives
      // before their old socket's `left` is ever seen, so presence never
      // changed — and the store would skip re-announcing `ready`, leaving them
      // waiting on a room screen for a peer who thinks they are already set.
      this.notifyPeerPresent(true);
      // They may have missed whatever we announced before they arrived; the
      // store re-announces `ready` from the presence callback.
      this.clock.kick();
      return;
    }
    this.setPeerPresent(false);
  }

  private onServerError(msg: ServerMessage & { type: 'error' }): void {
    this.report(msg.code, msg.message);
    // The close frame follows and carries the fatal code; marking it here means
    // the reconnect is blocked even if the close arrives first.
    this.fatal = true;
  }

  /**
   * Report a failure once. A single problem produces several events — an error
   * frame, then a close, then possibly a failed retry — and repeating the same
   * explanation each time makes the UI look broken rather than informative.
   */
  private report(code: SyncErrorCode, message: string): void {
    if (this.reportedError) return;
    this.reportedError = code;
    for (const handler of this.errorHandlers) handler(code, message);
  }

  /** The failure already explained for this connect attempt, if any. */
  get lastError(): SyncErrorCode | null {
    return this.reportedError;
  }

  // ------------------------------------------------------------ subscriptions

  on(handler: (msg: SyncMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  onPeerPresence(
    handler: (present: boolean, peerId: string | null) => void,
  ): () => void {
    this.presenceHandlers.add(handler);
    return () => {
      this.presenceHandlers.delete(handler);
    };
  }

  onAuthorityChange(handler: (isAuthority: boolean) => void): () => void {
    this.authorityHandlers.add(handler);
    return () => {
      this.authorityHandlers.delete(handler);
    };
  }

  onError(
    handler: (code: SyncErrorCode, message: string) => void,
  ): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  protected setPeerPresent(present: boolean): void {
    if (this.peerPresentValue === present) return;
    this.notifyPeerPresent(present);
  }

  private notifyPeerPresent(present: boolean): void {
    this.peerPresentValue = present;
    for (const handler of this.presenceHandlers) {
      handler(present, this.peerIdValue);
    }
  }

  protected setState(next: TransportState): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    for (const handler of this.stateHandlers) handler(next);
  }

  // ------------------------------------------------------------------ getters

  syncedNow(): number {
    return this.clock.syncedNow();
  }

  get rttMs(): number {
    return this.clock.rttMs;
  }

  get rttStdDevMs(): number {
    return this.clock.rttStdDevMs;
  }

  get lossRate(): number {
    return this.clock.lossRate;
  }

  get isAuthority(): boolean {
    return this.isAuthorityValue;
  }

  get state(): TransportState {
    return this.stateValue;
  }

  get peerPresent(): boolean {
    return this.peerPresentValue;
  }

  get peerId(): string | null {
    return this.peerIdValue;
  }
}
