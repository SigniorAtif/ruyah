/**
 * Wire + transport contract (spec §10).
 *
 * This file is the seam between Phase 1 (MockTransport, BroadcastChannel) and
 * Phase 2 (WebSocketTransport). Nothing here may know about video.
 *
 * Time rule (spec §5): every timestamp in this file is epoch milliseconds.
 * No timezones, no Date parsing, no date libraries anywhere under lib/sync.
 */

export type SyncMessage =
  | { type: 'play'; position: number; executeAt: number }
  // No executeAt: a pause is not scheduled. Whoever presses it stops at once
  // and the other stops on arrival, wherever that lands. The resulting position
  // mismatch is expected and is absorbed for free by the differential resume
  // (§6.2), so `position` is reported for information, not to correct toward.
  | { type: 'pause'; position: number }
  | { type: 'seek'; position: number; executeAt: number; wasPlaying: boolean }
  | { type: 'heartbeat'; position: number; playing: boolean; at: number }
  | { type: 'ready'; userId: string; fingerprint: string }
  | { type: 'ping'; t0: number }
  | { type: 'pong'; t0: number; t1: number }
  | { type: 'chat'; userId: string; text: string; at: number }; // wire only, no UI in Phase 1

/**
 * Why a session could not proceed.
 *
 * The first three are server-originated (Phase 2 §3). The rest are connection
 * failures the client works out for itself, and they are kept distinct because
 * the person reading the screen can act on each one differently: a typo in the
 * address, a relay that is down, a room that is full, and a relay that answered
 * but refused us are four different problems with four different fixes.
 */
export type SyncErrorCode =
  | 'room_full'
  | 'bad_message'
  | 'rate_limited'
  /** The URL is not a usable relay address. Never reached the network. */
  | 'invalid_url'
  /** Nothing answered: DNS, refused, TLS failure, or not a WebSocket endpoint. */
  | 'unreachable'
  /** The socket opened, then the relay turned us away. */
  | 'rejected';

export type TransportState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface SyncTransport {
  connect(roomId: string, userId: string): Promise<void>;
  disconnect(): void;
  send(msg: SyncMessage): void;
  on(handler: (msg: SyncMessage) => void): () => void; // returns unsubscribe

  /**
   * Additive to the spec's §10 interface: without it, every consumer has to
   * poll `state`. A WebSocketTransport implements this from its socket's
   * open/close/error events, so the Phase 2 swap is unaffected.
   */
  onStateChange(handler: (state: TransportState) => void): () => void;

  /**
   * Also additive to §10. Room membership is connection metadata, not a wire
   * message — §10's union deliberately has none — but §11's lobby has to show
   * "peer connected" before either side has pressed Ready. A real server knows
   * its room members natively, so Phase 2 implements this without a new
   * message type.
   */
  readonly peerPresent: boolean;
  /** The peer's userId while present. §8's overlay copy needs a real name. */
  readonly peerId: string | null;
  onPeerPresence(handler: (present: boolean, peerId: string | null) => void): () => void;

  /**
   * Additive to §10, for Phase 2 §3.
   *
   * Authority is assigned by the server and is sticky, so it normally never
   * changes mid-session. The one exception is a room left with no authority
   * present at all — both sides dropped and the wrong one came back — which the
   * server resolves by promoting the remaining member. That must reach the UI:
   * a silent promotion is exactly what §3 forbids, and the engine gates all
   * correction on this flag.
   *
   * MockTransport fixes authority at construction and never fires this.
   */
  onAuthorityChange(handler: (isAuthority: boolean) => void): () => void;

  /**
   * Also additive. Phase 1 had no way to be refused — a BroadcastChannel always
   * accepts you. A real server can say room_full, and the person reading the
   * screen needs to be told rather than left watching a spinner.
   */
  onError(handler: (code: SyncErrorCode, message: string) => void): () => void;

  syncedNow(): number; // reference-aligned epoch ms (§2: peer in Phase 1, server in Phase 2)
  readonly rttMs: number;
  readonly rttStdDevMs: number; // drives the jitter deadband, §7.3
  readonly isAuthority: boolean;
  readonly state: TransportState;
}

/** Knobs the dev panel drives (spec §10). Not part of the production seam. */
export interface NetworkConditions {
  /** One-way delay applied to every outbound message, ms. */
  latencyMs: number;
  /** Uniform +/- jitter added to latencyMs, ms. Causes real packet reordering. */
  jitterMs: number;
  /** Probability [0,1] that an outbound message is silently lost. */
  dropRate: number;
  /** false = this client's link is down: nothing leaves and nothing arrives. */
  connected: boolean;
}

/**
 * A transport that can lie about the network. Only MockTransport implements
 * this; the dev panel codes against it so no simulation types leak into
 * PlayerEngine.
 */
export interface SimulatedTransport extends SyncTransport {
  getNetwork(): NetworkConditions;
  setNetwork(patch: Partial<NetworkConditions>): void;
  /** Estimated offset from this client's clock to the authority's, ms. */
  readonly clockOffsetMs: number;
  readonly hasClockEstimate: boolean;
}

export function isSimulatedTransport(t: SyncTransport): t is SimulatedTransport {
  return typeof (t as SimulatedTransport).setNetwork === 'function';
}
