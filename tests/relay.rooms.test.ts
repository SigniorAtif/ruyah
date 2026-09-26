/**
 * Room registry (server §3) — capacity, seat reclamation, and the one thing
 * here worth thinking hard about: sticky authority.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRegistry } from '../server/rooms.js';
import { useFakeClock } from './harness/clock';

/** Stand-in for a socket; the registry only ever compares identity. */
const socket = (name: string) => ({ name });

let rooms: RoomRegistry;
let promoted: Array<{ userId: string }>;

beforeEach(() => {
  useFakeClock();
  promoted = [];
  rooms = new RoomRegistry({
    // rooms.js documents onPromote as (room, userId, ws); its JSDoc default is
    // a no-arg stub, so the arguments are read positionally here.
    onPromote: (...args: unknown[]) => {
      promoted.push({ userId: args[1] as string });
    },
  });
});

afterEach(() => {
  rooms.clear();
  vi.useRealTimers();
});

describe('seating', () => {
  it('gives authority to whoever creates the room', () => {
    const first = rooms.join('ABCDEF', 'ruaa', socket('a'));
    const second = rooms.join('ABCDEF', 'atif', socket('b'));

    expect(first.ok && first.isAuthority).toBe(true);
    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.isAuthority).toBe(false);
    expect(second.ok && second.roomSize).toBe(2);
  });

  it('tells the newcomer who is already seated', () => {
    rooms.join('ABCDEF', 'ruaa', socket('a'));
    const second = rooms.join('ABCDEF', 'atif', socket('b'));

    expect(second.ok && second.peers.map((p: { userId: string }) => p.userId)).toEqual(['ruaa']);
  });

  it('refuses a third person', () => {
    rooms.join('ABCDEF', 'ruaa', socket('a'));
    rooms.join('ABCDEF', 'atif', socket('b'));

    const third = rooms.join('ABCDEF', 'someone', socket('c'));

    expect(third.ok).toBe(false);
    expect(!third.ok && third.error).toBe('room_full');
  });

  it('lets the same userId reclaim its own seat past a half-open socket', () => {
    rooms.join('ABCDEF', 'ruaa', socket('a'));
    rooms.join('ABCDEF', 'atif', socket('b'));

    // Her network was pulled; the old TCP connection is still half-open, so
    // without this she would be refused as room_full by her own ghost.
    const again = rooms.join('ABCDEF', 'ruaa', socket('a2'));

    expect(again.ok).toBe(true);
    expect(again.ok && again.roomSize).toBe(2);
    expect(again.ok && again.replaced).toEqual(socket('a'));
    expect(again.ok && again.isAuthority).toBe(true); // her seat, her role
  });

  it('does not report a peer leaving when the seat was already taken over', () => {
    rooms.join('ABCDEF', 'ruaa', socket('a'));
    const old = socket('a');
    rooms.join('ABCDEF', 'ruaa', socket('a2'));

    // The dead socket's close event arrives late. Emitting `peer: left` here
    // would tear down a session that is in fact live.
    const result = rooms.leave('ABCDEF', 'ruaa', old);

    expect(result.removed).toBe(false);
    expect(result.peers).toEqual([]);
  });

  it('reports the remaining member when someone really leaves', () => {
    const a = socket('a');
    rooms.join('ABCDEF', 'ruaa', a);
    rooms.join('ABCDEF', 'atif', socket('b'));

    const result = rooms.leave('ABCDEF', 'ruaa', a);

    expect(result.removed).toBe(true);
    expect(result.peers.map((p: { userId: string }) => p.userId)).toEqual(['atif']);
  });
});

describe('sticky authority (§3)', () => {
  it('keeps the seat pinned across a disconnect', () => {
    const a = socket('a');
    rooms.join('ABCDEF', 'ruaa', a);
    rooms.join('ABCDEF', 'atif', socket('b'));

    rooms.leave('ABCDEF', 'ruaa', a);
    vi.advanceTimersByTime(3_000); // inside AUTHORITY_GRACE_MS
    const back = rooms.join('ABCDEF', 'ruaa', socket('a3'));

    expect(promoted).toEqual([]);
    expect(back.ok && back.isAuthority).toBe(true);
    // The follower was never promoted, so it is still following.
    const stillFollower = rooms.join('ABCDEF', 'atif', socket('b2'));
    expect(stillFollower.ok && stillFollower.isAuthority).toBe(false);
  });

  it('promotes the remaining member once the authority stays gone', () => {
    const a = socket('a');
    rooms.join('ABCDEF', 'ruaa', a);
    rooms.join('ABCDEF', 'atif', socket('b'));

    rooms.leave('ABCDEF', 'ruaa', a);
    vi.advanceTimersByTime(6_000); // past AUTHORITY_GRACE_MS

    // Otherwise the room is left with two followers, nobody corrects, and no
    // amount of waiting fixes it because the seat is pinned to someone gone.
    expect(promoted.map((p) => p.userId)).toEqual(['atif']);
  });

  it('never promotes while the authority is still connected', () => {
    rooms.join('ABCDEF', 'ruaa', socket('a'));
    const b = socket('b');
    rooms.join('ABCDEF', 'atif', b);

    rooms.leave('ABCDEF', 'atif', b);
    vi.advanceTimersByTime(30_000);

    // Two clients each convinced the other is following is the failure this
    // avoids; only an absent authority is ever replaced.
    expect(promoted).toEqual([]);
  });

  it('does not promote into an empty room', () => {
    const a = socket('a');
    const b = socket('b');
    rooms.join('ABCDEF', 'ruaa', a);
    rooms.join('ABCDEF', 'atif', b);

    rooms.leave('ABCDEF', 'ruaa', a);
    rooms.leave('ABCDEF', 'atif', b);
    vi.advanceTimersByTime(10_000);

    expect(promoted).toEqual([]);
  });
});

describe('room lifetime (§3)', () => {
  it('keeps an empty room alive through the grace window', () => {
    const a = socket('a');
    rooms.join('ABCDEF', 'ruaa', a);
    rooms.leave('ABCDEF', 'ruaa', a);

    vi.advanceTimersByTime(60_000); // inside ROOM_GRACE_MS
    expect(rooms.size).toBe(1);

    // A total outage on both sides must not drop the authority pin, or
    // whoever's TCP came back first would become the authority of a new room.
    const back = rooms.join('ABCDEF', 'ruaa', socket('a2'));
    expect(back.ok && back.created).toBe(false);
    expect(back.ok && back.isAuthority).toBe(true);
  });

  it('drops the room once the grace window passes', () => {
    const a = socket('a');
    rooms.join('ABCDEF', 'ruaa', a);
    rooms.leave('ABCDEF', 'ruaa', a);

    vi.advanceTimersByTime(95_000); // past ROOM_GRACE_MS
    expect(rooms.size).toBe(0);

    const fresh = rooms.join('ABCDEF', 'atif', socket('b'));
    expect(fresh.ok && fresh.created).toBe(true);
    expect(fresh.ok && fresh.isAuthority).toBe(true);
  });

  it('cancels the teardown when someone comes back in time', () => {
    const a = socket('a');
    rooms.join('ABCDEF', 'ruaa', a);
    rooms.leave('ABCDEF', 'ruaa', a);
    rooms.join('ABCDEF', 'ruaa', socket('a2'));

    vi.advanceTimersByTime(120_000);

    expect(rooms.size).toBe(1);
  });
});

describe('reading a room without touching it', () => {
  it('lists the others in a room', () => {
    rooms.join('ABCDEF', 'ruaa', socket('a'));
    rooms.join('ABCDEF', 'atif', socket('b'));

    expect(rooms.othersIn('ABCDEF', 'ruaa')).toEqual(['atif']);
    expect(rooms.othersIn('ABCDEF', 'atif')).toEqual(['ruaa']);
  });

  it('does not create or revive a room just by asking about it', () => {
    expect(rooms.othersIn('ZZZZZZ', 'ruaa')).toEqual([]);
    // The lobby probes this before offering a rejoin; a probe that created
    // rooms would let anyone fill the registry with empty ones.
    expect(rooms.size).toBe(0);
  });
});
