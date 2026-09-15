/**
 * Phase 1 transport (spec §10).
 *
 * BroadcastChannel, so two tabs on one machine behave as two peers, plus a
 * network simulator. A zero-latency mock hides every bug this design exists to
 * prevent, so latency, jitter, loss and a manual cable-pull are all first-class
 * here and driven from the dev panel.
 *
 * Phase 2 replaces this file with a WebSocketTransport implementing the same
 * SyncTransport interface. Nothing else changes.
 */

import { ClockSync } from './clock';
import type {
  NetworkConditions,
  SimulatedTransport,
  SyncMessage,
  TransportState,
} from './types';

const DEFAULT_NETWORK: NetworkConditions = {
  latencyMs: 120,
  jitterMs: 60,
  dropRate: 0,
  connected: true,
};

/** Modelled handshake time when the link comes back up. */
const RECONNECT_SETTLE_MS = 400;
/** Presence keepalive. A real server pushes membership; BroadcastChannel can't. */
const PRESENCE_INTERVAL_MS = 5_000;
const PRESENCE_TIMEOUT_MS = 12_000;

/**
 * Channel framing. This is the mock standing in for a server, not the wire
 * format: in Phase 2 the server owns routing and the socket carries the bare
 * SyncMessage, exactly as §10 describes.
 */
type Envelope =
  | {
      kind: 'hello';
      room: string;
      from: string;
      isAuthority: boolean;
      /** true when this hello is itself an answer, so greetings can't loop. */
      reply: boolean;
    }
  | { kind: 'msg'; room: string; from: string; msg: SyncMessage };

export interface MockTransportOptions {
  /** Room creator is the timing authority (§7.2). */
  isAuthority: boolean;
  network?: Partial<NetworkConditions>;
  channelPrefix?: string;
}

export class MockTransport implements SimulatedTransport {
  readonly isAuthority: boolean;

  private readonly channelPrefix: string;
  private net: NetworkConditions;

  private channel: BroadcastChannel | null = null;
  private roomId = '';
  private userId = '';
  private peerIdValue: string | null = null;

  private stateValue: TransportState = 'disconnected';
  private peerPresentValue = false;
  private lastPeerSeenAt = 0;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers = new Set<(msg: SyncMessage) => void>();
  private readonly stateHandlers = new Set<(state: TransportState) => void>();
  private readonly presenceHandlers = new Set<
    (present: boolean, peerId: string | null) => void
  >();

  /** In-flight simulated packets, so disconnect() doesn't leak them. */
  private readonly inFlight = new Set<ReturnType<typeof setTimeout>>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly clock: ClockSync;

  constructor(opts: MockTransportOptions) {
    this.isAuthority = opts.isAuthority;
    this.channelPrefix = opts.channelPrefix ?? 'ruyah-sync';
    this.net = { ...DEFAULT_NETWORK, ...opts.network };
    this.clock = new ClockSync({
      isAuthority: opts.isAuthority,
      send: (msg) => this.send(msg),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  async connect(roomId: string, userId: string): Promise<void> {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('MockTransport requires BroadcastChannel (browser only)');
    }
    this.disconnect();

    this.roomId = roomId;
    this.userId = userId;
    this.setState('connecting');

    const channel = new BroadcastChannel(`${this.channelPrefix}:${roomId}`);
    channel.onmessage = (ev: MessageEvent<Envelope>) => this.receiveLater(ev.data);
    this.channel = channel;

    this.clock.start();
    this.announce(false);
    this.startPresence();
    this.setState('connected');
  }

  disconnect(): void {
    this.clock.stop();
    this.stopPresence();
    this.setPeerPresent(false);
    for (const t of this.inFlight) clearTimeout(t);
    this.inFlight.clear();
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
    this.peerIdValue = null;
    if (this.stateValue !== 'disconnected') this.setState('disconnected');
  }

  // ------------------------------------------------------------------ sending

  send(msg: SyncMessage): void {
    const channel = this.channel;
    if (!channel) return;
    // Our own link is down: nothing leaves, and the caller is not told.
    // Silence is exactly what a real dropped connection looks like.
    if (!this.net.connected) return;
    if (this.net.dropRate > 0 && Math.random() < this.net.dropRate) return;

    const envelope: Envelope = {
      kind: 'msg',
      room: this.roomId,
      from: this.userId,
      msg,
    };
    this.deliverLater(envelope);
  }

  private announce(reply: boolean): void {
    if (!this.channel || !this.net.connected) return;
    this.deliverLater({
      kind: 'hello',
      room: this.roomId,
      from: this.userId,
      isAuthority: this.isAuthority,
      reply,
    });
  }

  /**
   * Delay for ONE traversal of this client's simulated link: half the
   * configured latency out, half of it back (see receiveLater).
   *
   * Splitting it is load-bearing, not cosmetic. An outbound-only delay is a
   * path where one leg is slower than the other by the full latency, and the
   * rtt/2 in ClockSync cannot see asymmetry — the delayed client's offset comes
   * out wrong by half of it. Every executeAt that client writes then fires half
   * the latency early in real time, so whoever has the slow link always starts
   * playing first, and the drift machine reads a flat zero the whole time
   * because the same bias cancels out of its heartbeat projection. Symmetric
   * halves cost the same round trip and leave the estimate unbiased.
   *
   * Each draw is independent, which is the other half of the point: it reorders
   * packets, which is what §7.3's stale-heartbeat guard has to survive.
   */
  private legDelayMs(): number {
    const jitter =
      this.net.jitterMs > 0 ? (Math.random() * 2 - 1) * this.net.jitterMs : 0;
    return Math.max(0, this.net.latencyMs / 2 + jitter / 2);
  }

  private deliverLater(envelope: Envelope): void {
    const channel = this.channel;
    if (!channel) return;

    const delay = this.legDelayMs();
    if (delay <= 0) {
      channel.postMessage(envelope);
      return;
    }

    const timer = setTimeout(() => {
      this.inFlight.delete(timer);
      // Re-check: the cable may have been pulled while this packet was in flight.
      if (!this.channel || !this.net.connected) return;
      this.channel.postMessage(envelope);
    }, delay);
    this.inFlight.add(timer);
  }

  /** The inbound half of this client's simulated link. */
  private receiveLater(envelope: Envelope): void {
    // Our own traffic comes back on the same channel and is discarded in
    // receive(); short-circuit it here so it never occupies a timer.
    if (envelope.from === this.userId) return;

    const delay = this.legDelayMs();
    if (delay <= 0) {
      this.receive(envelope);
      return;
    }

    const timer = setTimeout(() => {
      this.inFlight.delete(timer);
      if (!this.channel || !this.net.connected) return;
      this.receive(envelope);
    }, delay);
    this.inFlight.add(timer);
  }

  // ---------------------------------------------------------------- receiving

  private receive(env: Envelope): void {
    if (!this.channel) return;
    if (!this.net.connected) return; // our link is down in both directions
    if (env.room !== this.roomId) return;
    if (env.from === this.userId) return; // never hear ourselves

    if (this.peerIdValue === null) {
      this.peerIdValue = env.from;
    } else if (this.peerIdValue !== env.from) {
      console.warn('[ruyah] ignoring a third participant in the room:', env.from);
      // Phase 1 is strictly two participants (§14). A third tab is ignored
      // rather than silently corrupting the sync state.
      return;
    }

    this.lastPeerSeenAt = Date.now();
    this.setPeerPresent(true);

    if (env.kind === 'hello') {
      if (!env.reply) this.announce(true);
      // A peer just appeared: measure the offset now instead of waiting out
      // the burst retry.
      this.clock.kick();
      return;
    }

    // ping/pong belongs to the clock and must never reach the engine.
    if (this.clock.handleMessage(env.msg)) return;

    for (const handler of this.handlers) handler(env.msg);
  }

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

  /**
   * Authority is fixed at construction here: the room creator is the authority
   * for as long as the tab lives, and BroadcastChannel has no server to change
   * its mind. The subscription exists so the seam matches; it never fires.
   */
  onAuthorityChange(): () => void {
    return () => {};
  }

  /** Nothing can refuse a BroadcastChannel, so this never fires either. */
  onError(): () => void {
    return () => {};
  }

  get peerPresent(): boolean {
    return this.peerPresentValue;
  }

  private setPeerPresent(present: boolean): void {
    if (this.peerPresentValue === present) return;
    this.peerPresentValue = present;
    for (const handler of this.presenceHandlers) handler(present, this.peerIdValue);
  }

  private startPresence(): void {
    this.stopPresence();
    this.presenceTimer = setInterval(() => {
      this.announce(false);
      if (
        this.peerPresentValue &&
        Date.now() - this.lastPeerSeenAt > PRESENCE_TIMEOUT_MS
      ) {
        this.setPeerPresent(false);
      }
    }, PRESENCE_INTERVAL_MS);
  }

  private stopPresence(): void {
    if (this.presenceTimer !== null) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  private setState(next: TransportState): void {
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

  get state(): TransportState {
    return this.stateValue;
  }

  get clockOffsetMs(): number {
    return this.clock.offsetMs;
  }

  get hasClockEstimate(): boolean {
    return this.clock.hasEstimate;
  }

  get peerId(): string | null {
    return this.peerIdValue;
  }

  // ------------------------------------------------------------- simulation

  /** Counterpart of WebSocketTransport.debugInfo; see there. */
  debugInfo(): Record<string, unknown> {
    return {
      socket: this.channel ? 'channel' : 'null',
      transport: this.stateValue,
      netConnected: this.net.connected,
      latencyMs: this.net.latencyMs,
      jitterMs: this.net.jitterMs,
      dropRate: this.net.dropRate,
      inFlight: this.inFlight.size,
      peerPresent: this.peerPresentValue,
      clockEstimate: this.clock.hasEstimate,
      offsetMs: Math.round(this.clock.offsetMs),
    };
  }

  getNetwork(): NetworkConditions {
    return { ...this.net };
  }

  setNetwork(patch: Partial<NetworkConditions>): void {
    const wasConnected = this.net.connected;
    this.net = { ...this.net, ...patch };

    if (wasConnected && !this.net.connected) {
      this.pullCable();
    } else if (!wasConnected && this.net.connected) {
      this.restoreCable();
    }
  }

  private pullCable(): void {
    for (const t of this.inFlight) clearTimeout(t);
    this.inFlight.clear();
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.clock.stop();
    // Our link is down, so by definition we can no longer see anyone.
    this.setPeerPresent(false);
    this.setState('disconnected');
  }

  private restoreCable(): void {
    if (!this.channel) return;
    this.setState('reconnecting');
    // §8: the old offset is stale and the path may have changed, so estimation
    // restarts from scratch rather than smoothing into a dead estimate.
    this.clock.reset();
    this.clock.start();
    this.announce(false);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.net.connected && this.channel) this.setState('connected');
    }, RECONNECT_SETTLE_MS);
  }
}
