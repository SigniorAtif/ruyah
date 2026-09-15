/**
 * Message validation (spec §4).
 *
 * The rule from §1: if the server needs to understand a message to relay it,
 * the design has gone wrong. So this file checks shape and nothing else. It
 * knows the set of type strings and the size cap. It does not know what a
 * position is, does not look at executeAt, and never rebuilds a frame — the
 * relay path in index.js forwards the original bytes (§4, "relay is verbatim").
 */

/** §4. Nothing in the protocol comes close; anything that does is not our client. */
export const MAX_MESSAGE_BYTES = 4096;

/** §4. Normal operation is well under 1/sec. */
export const RATE_LIMIT_PER_SEC = 50;
export const RATE_WINDOW_MS = 1_000;

/** §4. Past this the peer is not keeping up and heartbeats are dropped. */
export const BACKPRESSURE_BYTES = 64 * 1024;

/** §4. Socket-level keepalive; two missed pongs and the connection is dead. */
export const SOCKET_PING_INTERVAL_MS = 30_000;
export const SOCKET_PING_MAX_MISSED = 2;

/** §3. An empty room outlives a total outage on both sides. */
export const ROOM_GRACE_MS = 90_000;

/** §3. Phase 2 is two people. */
export const ROOM_CAPACITY = 2;

/**
 * How long a room may sit with nobody holding authority before the remaining
 * member is promoted.
 *
 * §3 says the follower must never SILENTLY become the authority, and that still
 * holds: promotion here is announced with a fresh `joined`, and it only happens
 * when the authority is absent entirely. The case it fixes is a room left with
 * two followers — both sides dropped, and the one who came back was not the
 * creator. Nobody corrects, drift grows without bound, and no amount of waiting
 * fixes it because the seat is pinned to someone who is gone. Five seconds is
 * long enough that a normal reconnect (§5's 500ms backoff) gets the original
 * authority back in first.
 */
export const AUTHORITY_GRACE_MS = 5_000;

/**
 * §7. Same alphabet as the client's randomRoomCode (lib/store.ts): no O/0,
 * no I/1/l. Validating against it means a scanner probing random strings is
 * rejected before it ever touches the room registry.
 */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** `ready.userId` carries a display name, so allow most of it but bound it. */
export const MAX_USER_ID_LENGTH = 64;

/**
 * §2: ping/pong are terminated at the server now, not forwarded. Everything
 * else is relayed untouched. Keeping the two sets separate is what makes that
 * distinction a single lookup rather than a special case in the hot path.
 */
export const CLOCK_TYPES = new Set(['ping', 'pong']);
export const RELAY_TYPES = new Set([
  'play',
  'pause',
  'seek',
  'heartbeat',
  'ready',
  'chat',
]);
export const KNOWN_TYPES = new Set([...CLOCK_TYPES, ...RELAY_TYPES]);

/** §4: only heartbeat may be dropped under backpressure. */
export const DROPPABLE_UNDER_BACKPRESSURE = new Set(['heartbeat']);

/**
 * Close codes. 4000-4999 is the application-private range. The client needs
 * these distinguishable: room_full must not trigger the reconnect backoff,
 * and a replaced connection must not be reported to the user at all.
 */
export const CLOSE = {
  ROOM_FULL: 4001,
  RATE_LIMITED: 4002,
  BAD_MESSAGE: 4003,
  /** The same userId opened a new socket and took this one's seat. */
  REPLACED: 4004,
  SHUTDOWN: 4005,
};

/** Control characters would corrupt log lines and mean nothing on the wire. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Validate an inbound frame.
 *
 * Returns the parsed object only so the caller can branch on `type` and read
 * `ping.t0`. The caller relays `raw`, never a re-serialisation of this.
 */
export function parseFrame(raw) {
  if (raw.length > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: 'oversize' };
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not_json' };
  }

  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, reason: 'not_an_object' };
  }
  if (typeof msg.type !== 'string') {
    return { ok: false, reason: 'no_type' };
  }
  if (!KNOWN_TYPES.has(msg.type)) {
    return { ok: false, reason: 'unknown_type' };
  }
  // The one field the server reads, so the one field it checks. t0 is echoed
  // back in the pong and the client subtracts it from its own clock; a string
  // or a NaN there would silently poison an offset estimate.
  if (msg.type === 'ping' && !Number.isFinite(msg.t0)) {
    return { ok: false, reason: 'bad_ping' };
  }

  return { ok: true, msg };
}

export function isValidUserId(userId) {
  return (
    typeof userId === 'string' &&
    userId.length > 0 &&
    userId.length <= MAX_USER_ID_LENGTH &&
    !CONTROL_CHARS.test(userId)
  );
}
