/**
 * The relay transport with a network simulator bolted on — dev tools only.
 *
 * Nothing imports this outside a `DEV_TOOLS` branch (lib/devTools.ts), so a
 * build without dev tools drops the whole file. It overrides the base class's
 * pass-through hooks rather than living inside it, which keeps the production
 * send and receive paths free of it.
 */

import type { NetworkConditions, SimulatedTransport, SyncMessage } from './types';
import { WebSocketTransport, type WebSocketTransportOptions } from './websocketTransport';

/**
 * The real network already supplies latency, jitter and loss, so the simulator
 * starts inert. The dev panel can still add more on top — the delay is applied
 * to our own outbound sends, which is a genuine one-way delay, not a pretend
 * one — and `connected: false` closes the socket for real (§5).
 */
const DEFAULT_NETWORK: NetworkConditions = {
  latencyMs: 0,
  jitterMs: 0,
  dropRate: 0,
  connected: true,
};

export class SimulatedWebSocketTransport extends WebSocketTransport implements SimulatedTransport {
  private net: NetworkConditions;
  /** In-flight simulated sends, so a disconnect doesn't leak them. */
  private readonly pendingSends = new Set<ReturnType<typeof setTimeout>>();
  /** Same, for the inbound half of the simulated delay. */
  private readonly pendingReceives = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: WebSocketTransportOptions & { network?: Partial<NetworkConditions> }) {
    super(opts);
    this.net = { ...DEFAULT_NETWORK, ...opts.network };
  }

  disconnect(): void {
    this.clearPendingSends();
    super.disconnect();
  }

  send(msg: SyncMessage): void {
    if (!this.net.connected) return;
    if (this.net.dropRate > 0 && Math.random() < this.net.dropRate) return;

    const delay = this.legDelayMs();
    if (delay <= 0) {
      super.send(msg);
      return;
    }

    const timer = setTimeout(() => {
      this.pendingSends.delete(timer);
      // Re-check: the link may have gone while this was waiting, and a delayed
      // send that lands after a reconnect would describe a world that is gone.
      if (!this.net.connected) return;
      super.send(msg);
    }, delay);
    this.pendingSends.add(timer);
  }

  protected linkUp(): boolean {
    return this.net.connected;
  }

  protected onSocketData(data: unknown): void {
    const delay = this.legDelayMs();
    if (delay <= 0) {
      super.onSocketData(data);
      return;
    }
    // The inbound half of the simulated link. Drawn independently of the
    // outbound draw, so packets still reorder.
    const socket = this.socket;
    const timer = setTimeout(() => {
      this.pendingReceives.delete(timer);
      if (this.socket !== socket || !this.net.connected) return;
      super.onSocketData(data);
    }, delay);
    this.pendingReceives.add(timer);
  }

  /**
   * Delay for ONE traversal of the simulated link — half the configured
   * latency, because the other half is charged on the opposite direction.
   *
   * The whole point is symmetry. Charging the full latency outbound and
   * nothing inbound is a path where one leg is infinitely slower than the
   * other, and ClockSync's halving cannot see that: this client's offset comes
   * out wrong by half the injected latency, so every executeAt it writes fires
   * that much early in real time while its drift readout stays at zero,
   * because the same bias cancels out of the heartbeat projection. A link that
   * adds the same delay each way costs the same round trip and leaves the
   * estimate unbiased.
   */
  private legDelayMs(): number {
    const jitter = this.net.jitterMs > 0 ? (Math.random() * 2 - 1) * this.net.jitterMs : 0;
    return Math.max(0, this.net.latencyMs / 2 + jitter / 2);
  }

  private clearPendingSends(): void {
    for (const t of this.pendingSends) clearTimeout(t);
    this.pendingSends.clear();
    for (const t of this.pendingReceives) clearTimeout(t);
    this.pendingReceives.clear();
  }

  /**
   * Everything the §8 watchdog cannot see from inside the engine, for the
   * moment it declares a peer lost. Not part of SyncTransport: the engine
   * feature-detects it, so the production seam stays as §10 defines it.
   */
  debugInfo(): Record<string, unknown> {
    const READY = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return {
      socket: this.socket ? (READY[this.socket.readyState] ?? this.socket.readyState) : 'null',
      transport: this.stateValue,
      netConnected: this.net.connected,
      latencyMs: this.net.latencyMs,
      jitterMs: this.net.jitterMs,
      dropRate: this.net.dropRate,
      pendingSends: this.pendingSends.size,
      pendingReceives: this.pendingReceives.size,
      fatal: this.fatal,
      everJoined: this.everJoined,
      peerPresent: this.peerPresentValue,
      reportedError: this.reportedError,
      clockEstimate: this.clock.hasEstimate,
      offsetMs: Math.round(this.clock.offsetMs),
    };
  }

  get clockOffsetMs(): number {
    return this.clock.offsetMs;
  }

  get hasClockEstimate(): boolean {
    return this.clock.hasEstimate;
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

  /**
   * §5: the dev panel's drop toggle closes the socket for real. Simulating a
   * dead link by dropping messages while the socket stays open would exercise
   * the wrong half of §8 — the reconnect path is the part worth testing, and it
   * only runs when the socket actually goes away.
   */
  private pullCable(): void {
    this.clearRetry();
    this.clearConnectTimer();
    this.clearPendingSends();
    this.clock.stop();
    this.teardownSocket();
    this.setPeerPresent(false);
    this.setState('disconnected');
  }

  private restoreCable(): void {
    if (this.closedByUs || this.fatal) return;
    this.attempt = 0;
    this.setState('reconnecting');
    this.open();
  }
}
