/**
 * Who is in a room, asked of the relay without taking a seat (its `probe`
 * query). The lobby uses it to offer a rejoin only while the other person is
 * still there.
 *
 * A relay from before the probe existed refuses it as a bad user id, which is
 * `unsupported`; one that is down or not listening never opens at all, which is
 * `unreachable`. Neither means the room is empty, and the lobby says which it
 * was rather than leaving it at "could not check".
 */

export type Presence =
  | { kind: 'there'; others: string[] }
  | { kind: 'empty' }
  /** Nothing listening there, or it never answered in time. */
  | { kind: 'unreachable' }
  /** A relay answered, but not with a presence frame: it predates the probe. */
  | { kind: 'unsupported' };

const PROBE_TIMEOUT_MS = 4_000;

export function probePresence(relayUrl: string, code: string, asUserId: string): Promise<Presence> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        `${relayUrl}?room=${encodeURIComponent(code)}&probe=1&as=${encodeURIComponent(asUserId)}`,
      );
    } catch {
      // Not a usable address at all, e.g. the empty one that selects the mock.
      resolve({ kind: 'unreachable' });
      return;
    }
    let opened = false;
    let settled = false;
    const finish = (p: Presence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      resolve(p);
    };
    const timer = setTimeout(() => finish(opened ? { kind: 'unsupported' } : { kind: 'unreachable' }), PROBE_TIMEOUT_MS);
    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; others?: unknown };
        if (msg.type === 'presence' && Array.isArray(msg.others)) {
          const others = msg.others.filter((o): o is string => typeof o === 'string');
          finish(others.length ? { kind: 'there', others } : { kind: 'empty' });
          return;
        }
      } catch {
        /* fall through */
      }
      // It answered with something else: an older relay's refusal frame.
      finish({ kind: 'unsupported' });
    };
    // A socket that opened and then closed was a relay that would not answer;
    // one that never opened was not there at all.
    socket.onclose = () => finish(opened ? { kind: 'unsupported' } : { kind: 'unreachable' });
    socket.onerror = () => finish(opened ? { kind: 'unsupported' } : { kind: 'unreachable' });
  });
}
