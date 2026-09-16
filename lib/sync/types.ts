/**
 * Wire + transport contract (spec §10).
 *
 * The seam every transport implements. Nothing here may know about video.
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
  // rttMs is this sender's own measured round trip, piggybacked so the peer can
  // size its scheduling lead against the SLOWER of the two links rather than
  // only its own (§6). Optional: a peer that does not send it is simply not
  // counted, which is the pre-existing behaviour.
  | {
      type: 'heartbeat';
      position: number;
      playing: boolean;
      at: number;
      rttMs?: number;
      /** Sender's measured loss, so the receiver can size §8 against the worse link. */
      lossRate?: number;
    }
  | { type: 'ready'; userId: string; fingerprint: string }
  | { type: 'ping'; t0: number }
  // Four-stamp NTP (§5.1). t1 is receipt and t2 is dispatch, both on the
  // responder's clock; the gap between them is the responder's own processing
  // time, which is pure asymmetry and has to be subtracted rather than split.
  // t2 is optional so an older responder that only sends t1 still works — the
  // estimate then degrades to the three-stamp form it always used.
  | { type: 'pong'; t0: number; t1: number; t2?: number }
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
  readonly lossRate: number; // 0..1, unanswered pings; sizes §8's dropout probes
  readonly isAuthority: boolean;
  readonly state: TransportState;
}
