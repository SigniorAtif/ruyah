/**
 * Ruya sync relay (spec §1, §4).
 *
 * Holds rooms, relays messages to the other member unmodified, answers ping.
 * It does not know what a video is, never sees one, stores nothing on disk and
 * has no opinion about position or executeAt.
 *
 * Run:   node server/index.js
 * Env:   RUYAH_PORT (8080), RUYAH_HOST (127.0.0.1)
 *
 * RUYAH_HOST defaults to loopback because §6 puts Caddy in front and terminates
 * TLS there; binding 0.0.0.0 on the box would expose the relay directly, past
 * the certificate. Set RUYAH_HOST=0.0.0.0 only for plaintext LAN testing.
 */

import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { RoomRegistry } from './rooms.js';
import {
  AUTHORITY_GRACE_MS,
  BACKPRESSURE_BYTES,
  CLOSE,
  CLOCK_TYPES,
  DROPPABLE_UNDER_BACKPRESSURE,
  MAX_MESSAGE_BYTES,
  RATE_LIMIT_PER_SEC,
  RATE_WINDOW_MS,
  ROOM_CODE_RE,
  ROOM_GRACE_MS,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_PING_MAX_MISSED,
  isValidUserId,
  parseFrame,
} from './protocol.js';

const PORT = Number(process.env.RUYAH_PORT ?? 8080);
const HOST = process.env.RUYAH_HOST ?? '127.0.0.1';

/**
 * Test knobs. The spec's values are the defaults and production never sets
 * these — they exist because a 30s keepalive and a 90s grace period are
 * otherwise only observable by waiting two minutes per assertion, which in
 * practice means nobody checks them.
 */
const PING_INTERVAL_MS = Number(process.env.RUYAH_PING_INTERVAL_MS ?? SOCKET_PING_INTERVAL_MS);
const GRACE_MS = Number(process.env.RUYAH_ROOM_GRACE_MS ?? ROOM_GRACE_MS);
/**
 * Same reasoning, one step further: on loopback the kernel will happily absorb
 * megabytes for a peer that has stopped reading, so `bufferedAmount` never
 * reaches 64KB in a local test and the drop branch is never exercised. Setting
 * this negative makes the condition always true, which is the only way to prove
 * that heartbeats are the only thing it discards.
 */
const BACKPRESSURE_LIMIT = Number(process.env.RUYAH_BACKPRESSURE_BYTES ?? BACKPRESSURE_BYTES);
const AUTHORITY_GRACE = Number(
  process.env.RUYAH_AUTHORITY_GRACE_MS ?? AUTHORITY_GRACE_MS,
);

const rooms = new RoomRegistry({
  graceMs: GRACE_MS,
  authorityGraceMs: AUTHORITY_GRACE,
  /**
   * A room left with nobody holding authority cannot recover on its own: two
   * followers both wait for a correction that will never come. The registry
   * picks who; this announces it with a fresh `joined`, so the promotion is
   * explicit rather than the silent one §3 forbids.
   */
  onPromote: (room, userId, ws) => {
    log('promote', `room=${tag(room.code)}`, `user=${tag(userId)}`);
    sendJson(ws, {
      type: 'joined',
      userId,
      isAuthority: true,
      roomSize: room.members.size,
    });
  },
});

/**
 * §7: log connections, never message contents. Room codes are the only access
 * control in this system, so they are a credential and do not belong in a log
 * file either; userIds carry a display name, which is a real person's name.
 * Both are logged as a short digest — stable enough to follow one session
 * through a log, useless to anyone who finds the log.
 */
function tag(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 6);
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

/** §3. Sent, then the socket closes; the client must see why it was refused. */
function refuse(ws, code, message, closeCode) {
  if (ws.ruyah) ws.ruyah.refused = true;
  sendJson(ws, { type: 'error', code, message });
  ws.close(closeCode, code);
}

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  // §4's 4KB cap, enforced by the protocol layer before a frame is buffered
  // rather than after we have already paid to receive it.
  maxPayload: MAX_MESSAGE_BYTES,
  // §6's Caddyfile proxies /ws. Anything else gets a 400 at the upgrade.
  path: '/ws',
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://relay.invalid');
  const code = (url.searchParams.get('room') ?? '').toUpperCase();
  const userId = url.searchParams.get('user') ?? '';

  // Deliberately not logged: anything on the public internet gets scanned, and
  // a log line per malformed probe is a free way for a stranger to fill the
  // disk. A refused probe never reaches the room registry, so there is nothing
  // to correlate anyway.
  if (!ROOM_CODE_RE.test(code) || !isValidUserId(userId)) {
    refuse(ws, 'bad_message', 'Bad room code or user id.', CLOSE.BAD_MESSAGE);
    return;
  }

  const seat = rooms.join(code, userId, ws);
  if (!seat.ok) {
    log('reject room_full', `room=${tag(code)}`, `user=${tag(userId)}`);
    refuse(ws, 'room_full', 'That room already has two people in it.', CLOSE.ROOM_FULL);
    return;
  }

  // Per-connection state. Attached to the socket so the ping sweep and the
  // rate limiter can reach it without a second lookup structure.
  ws.ruyah = {
    code,
    userId,
    room: seat.room,
    missedPongs: 0,
    windowStart: 0,
    windowCount: 0,
    droppedHeartbeats: 0,
    /**
     * A close is not instant: frames already in the receive buffer still reach
     * the handler afterwards. Without this, one rate-limited client writes a
     * log line per queued frame — which is the same disk-filling problem the
     * rate limit exists to prevent.
     */
    refused: false,
  };

  if (seat.replaced && seat.replaced !== ws) {
    // Same userId, new socket: the old one is a ghost holding a seat. Its
    // close handler will find the seat already reassigned and stay quiet, so
    // the surviving peer never sees a spurious left/joined pair.
    seat.replaced.close(CLOSE.REPLACED, 'replaced');
  }

  log(
    'join',
    `room=${tag(code)}`,
    `user=${tag(userId)}`,
    `authority=${seat.isAuthority}`,
    `size=${seat.roomSize}`,
    seat.replaced ? 'reconnect' : seat.created ? 'created' : '',
  );

  // §3: sent to the connecting client immediately on accept, before anything
  // else, so the client knows its role before a single relayed frame lands.
  sendJson(ws, {
    type: 'joined',
    userId,
    isAuthority: seat.isAuthority,
    roomSize: seat.roomSize,
  });

  // §3: both sides get `peer: joined`. The newcomer learns about whoever was
  // already seated; the sitter learns about the newcomer.
  for (const peer of seat.peers) {
    sendJson(ws, { type: 'peer', event: 'joined', userId: peer.userId });
    sendJson(peer.ws, { type: 'peer', event: 'joined', userId });
  }

  ws.on('pong', () => {
    ws.ruyah.missedPongs = 0;
  });

  ws.on('message', (raw) => {
    // §2: FIRST statement. Not after the parse, not after the room lookup, not
    // after a log line. Every millisecond spent above this line is a constant
    // bias in the offset estimate of every client on this server.
    const t1 = Date.now();

    const state = ws.ruyah;
    if (state.refused) return; // already closing; drain the buffer in silence

    // §4: 50 msg/sec. A fixed window rather than a token bucket — the limit is
    // two orders of magnitude above normal traffic, so the only thing it has to
    // separate is "working" from "broken or hostile".
    if (t1 - state.windowStart >= RATE_WINDOW_MS) {
      state.windowStart = t1;
      state.windowCount = 0;
    }
    if (++state.windowCount > RATE_LIMIT_PER_SEC) {
      log('reject rate_limited', `room=${tag(state.code)}`, `user=${tag(state.userId)}`);
      refuse(ws, 'rate_limited', 'Too many messages.', CLOSE.RATE_LIMITED);
      return;
    }

    const parsed = parseFrame(raw);
    if (!parsed.ok) {
      log(
        'reject bad_message',
        `room=${tag(state.code)}`,
        `user=${tag(state.userId)}`,
        `reason=${parsed.reason}`,
      );
      refuse(ws, 'bad_message', 'Unrecognised message.', CLOSE.BAD_MESSAGE);
      return;
    }

    const { type } = parsed.msg;

    // §2: ping/pong terminate here. They are not relayed — the peer's clock is
    // no longer the reference, so forwarding one would measure the wrong thing.
    if (CLOCK_TYPES.has(type)) {
      if (type === 'ping') {
        // Four-stamp NTP: t1 is when this frame arrived, t2 is when the answer
        // leaves. Everything between them — parsing, rate-limit bookkeeping,
        // event-loop delay — is time spent on one leg only, so the client
        // subtracts it instead of splitting it down the middle and biasing its
        // offset by half of whatever this server happened to be busy with.
        sendJson(ws, { type: 'pong', t0: parsed.msg.t0, t1, t2: Date.now() });
      }
      // A client has no reason to send `pong`; it is in the union because the
      // server sends it. Dropping it is enough — it is well-formed, so closing
      // the connection over it would be a harsher response than the mistake.
      return;
    }

    const peer = rooms.peerOf(state.room, state.userId);
    if (!peer || peer.ws.readyState !== peer.ws.OPEN) return; // alone in the room

    // §4: backpressure. A stale heartbeat is worthless — the next one is 3s
    // away — but play/pause/seek/ready are one-shot and queueing is correct.
    if (
      peer.ws.bufferedAmount > BACKPRESSURE_LIMIT &&
      DROPPABLE_UNDER_BACKPRESSURE.has(type)
    ) {
      state.droppedHeartbeats++;
      return;
    }

    // §4: verbatim. The original bytes go out — not a re-serialisation of the
    // parsed object, which would be at the mercy of key ordering and float
    // formatting. `executeAt` crosses byte-identical because nothing here ever
    // touches it. `binary: false` keeps it a text frame, as it arrived.
    peer.ws.send(raw, { binary: false });
  });

  ws.on('close', () => {
    const state = ws.ruyah;
    const { removed, peers } = rooms.leave(state.code, state.userId, ws);
    if (!removed) return; // seat already reclaimed by a reconnect; stay quiet

    log(
      'leave',
      `room=${tag(state.code)}`,
      `user=${tag(state.userId)}`,
      `droppedHeartbeats=${state.droppedHeartbeats}`,
    );

    // §3: the remaining member gets `peer: left` and the client's §8 dropout
    // path takes it from there.
    for (const peer of peers) {
      sendJson(peer.ws, { type: 'peer', event: 'left', userId: state.userId });
    }
  });

  ws.on('error', () => {
    // 'close' always follows, and that is where the seat is released. Swallow
    // it here so a reset connection cannot take the process down.
  });
});

/**
 * §4: socket-level keepalive. Without it a dead TCP connection lingers and the
 * room stays occupied by a ghost — the client-level heartbeat is a different
 * mechanism with a different job and will not clear this.
 */
const pingSweep = setInterval(() => {
  for (const ws of wss.clients) {
    const state = ws.ruyah;
    if (!state) continue;
    if (state.missedPongs >= SOCKET_PING_MAX_MISSED) {
      log('terminate stale', `room=${tag(state.code)}`, `user=${tag(state.userId)}`);
      ws.terminate();
      continue;
    }
    state.missedPongs++;
    ws.ping();
  }
}, PING_INTERVAL_MS);
pingSweep.unref?.();

wss.on('listening', () => {
  log(
    `relay listening on ws://${HOST}:${PORT}/ws`,
    `ping=${PING_INTERVAL_MS}ms`,
    `grace=${GRACE_MS}ms`,
    `backpressure=${BACKPRESSURE_LIMIT}B`,
    `authorityGrace=${AUTHORITY_GRACE}ms`,
  );
});

wss.on('error', (err) => {
  log('server error', err.message);
  process.exit(1);
});

/**
 * §6 runs this under systemd with Restart=always. A clean close on SIGTERM
 * means clients see a close frame and start their backoff immediately, rather
 * than waiting out a socket timeout on a process that is already gone.
 */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    log(`${signal} — closing`);
    clearInterval(pingSweep);
    for (const ws of wss.clients) ws.close(CLOSE.SHUTDOWN, 'shutdown');
    rooms.clear();
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref?.();
  });
}
