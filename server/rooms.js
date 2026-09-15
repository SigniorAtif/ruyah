/**
 * Room registry (spec §3, §4).
 *
 * In memory, dies with the process, holds no video and no playback state. The
 * only thing here worth thinking hard about is authority stickiness.
 *
 * §3: `isAuthority` is sticky for the life of the room. The follower must never
 * silently be promoted — if both sides believed they were the authority, or
 * neither did, both would stop correcting and the whole §7.2 arrangement
 * collapses. So authority is pinned to a userId at room creation and only that
 * userId can ever hold it, even across a disconnect.
 *
 * That is also why an empty room is not destroyed immediately (§3): a total
 * outage on both sides would otherwise drop the pin, and whoever's TCP came
 * back first would create a fresh room and become the authority.
 */

import { AUTHORITY_GRACE_MS, ROOM_CAPACITY, ROOM_GRACE_MS } from './protocol.js';

export class RoomRegistry {
  /** @type {Map<string, Room>} */
  #rooms = new Map();
  #graceMs;
  #authorityGraceMs;
  #onPromote;

  /**
   * `onPromote(room, userId, ws)` is called when a room has been left with no
   * authority present for too long. The registry decides who; the caller owns
   * telling them, because the registry does not know how to write a frame.
   */
  constructor({
    graceMs = ROOM_GRACE_MS,
    authorityGraceMs = AUTHORITY_GRACE_MS,
    onPromote = () => {},
  } = {}) {
    this.#graceMs = graceMs;
    this.#authorityGraceMs = authorityGraceMs;
    this.#onPromote = onPromote;
  }

  get size() {
    return this.#rooms.size;
  }

  /**
   * Seat a connection.
   *
   * @returns {{ok: true, room: Room, isAuthority: boolean, roomSize: number,
   *            peers: Array<{userId: string, ws: object}>, replaced: object|null, created: boolean}
   *          | {ok: false, error: 'room_full'}}
   */
  join(code, userId, ws) {
    let room = this.#rooms.get(code);
    const created = room === undefined;

    if (created) {
      room = {
        code,
        // Insertion order is seating order, which is how a promotion picks the
        // longest-present member without carrying a separate sequence number.
        members: new Map(),
        // First member holds authority until they are gone AND stay gone.
        authorityId: userId,
        graceTimer: null,
        authorityTimer: null,
        createdAt: Date.now(),
      };
      this.#rooms.set(code, room);
    }

    // A reconnect that beats the dead socket's close event would otherwise be
    // rejected as room_full by its own ghost. The same userId always reclaims
    // its own seat — this is the acceptance path in §8.5, where one client's
    // network is pulled for 60s and the old TCP connection is still half-open.
    const stale = room.members.get(userId) ?? null;
    if (!stale && room.members.size >= ROOM_CAPACITY) {
      return { ok: false, error: 'room_full' };
    }

    // Anyone already seated, captured before the newcomer is added, so the
    // caller can send the newcomer a `peer: joined` for each of them.
    const peers = [...room.members]
      .filter(([id]) => id !== userId)
      .map(([id, peerWs]) => ({ userId: id, ws: peerWs }));

    if (room.graceTimer !== null) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }

    room.members.set(userId, ws);
    this.#evaluateAuthority(room);

    return {
      ok: true,
      room,
      isAuthority: userId === room.authorityId,
      roomSize: room.members.size,
      peers,
      replaced: stale,
      created,
    };
  }

  /**
   * Release a seat.
   *
   * `removed` is false when this connection no longer held the seat — it was
   * already replaced by a reconnect from the same userId. That case must not
   * emit `peer: left`, or the surviving peer would tear down a session that is
   * in fact live.
   *
   * @returns {{removed: boolean, peers: Array<{userId: string, ws: object}>}}
   */
  leave(code, userId, ws) {
    const room = this.#rooms.get(code);
    if (!room) return { removed: false, peers: [] };

    if (room.members.get(userId) !== ws) return { removed: false, peers: [] };
    room.members.delete(userId);

    const peers = [...room.members].map(([id, peerWs]) => ({ userId: id, ws: peerWs }));

    this.#evaluateAuthority(room);

    if (room.members.size === 0) {
      room.graceTimer = setTimeout(() => {
        // Re-check: a rejoin during the grace window clears this timer, but
        // guard anyway rather than trust timer bookkeeping with a live room.
        const current = this.#rooms.get(code);
        if (current !== room || room.members.size !== 0) return;
        if (room.authorityTimer !== null) {
          clearTimeout(room.authorityTimer);
          room.authorityTimer = null;
        }
        this.#rooms.delete(code);
      }, this.#graceMs);
      // The listening socket keeps the process alive; a pending room teardown
      // should not be the thing that does.
      room.graceTimer.unref?.();
    }

    return { removed: true, peers };
  }

  /**
   * Keep exactly one authority reachable in the room.
   *
   * Does nothing while the pinned authority is connected — that is §3's
   * stickiness and it is not negotiable, because a promotion while the real
   * authority is present would leave two clients each convinced the other is
   * following, and neither correcting.
   *
   * The timer is the whole point. An authority that drops and reconnects inside
   * the window resumes its seat and nothing happens; only a room that is still
   * leaderless after the window gets a new one.
   */
  #evaluateAuthority(room) {
    const authorityPresent = room.members.has(room.authorityId);

    if (authorityPresent || room.members.size === 0) {
      if (room.authorityTimer !== null) {
        clearTimeout(room.authorityTimer);
        room.authorityTimer = null;
      }
      return;
    }

    if (room.authorityTimer !== null) return; // already counting down

    room.authorityTimer = setTimeout(() => {
      room.authorityTimer = null;
      // Re-check everything: the authority may have reconnected, or the room
      // may have emptied, while this was pending.
      if (this.#rooms.get(room.code) !== room) return;
      if (room.members.size === 0) return;
      if (room.members.has(room.authorityId)) return;

      // Longest-seated member, by Map insertion order.
      const [userId, ws] = [...room.members][0];
      room.authorityId = userId;
      this.#onPromote(room, userId, ws);
    }, this.#authorityGraceMs);
    room.authorityTimer.unref?.();
  }

  /** The other member, or null while alone. Phase 2 rooms hold two people. */
  peerOf(room, userId) {
    for (const [id, ws] of room.members) {
      if (id !== userId) return { userId: id, ws };
    }
    return null;
  }

  /** Cancel every pending teardown, so shutdown doesn't hang on a timer. */
  clear() {
    for (const room of this.#rooms.values()) {
      if (room.graceTimer !== null) clearTimeout(room.graceTimer);
      if (room.authorityTimer !== null) clearTimeout(room.authorityTimer);
    }
    this.#rooms.clear();
  }
}
