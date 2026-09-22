/**
 * Who is in a room, asked of the relay without taking a seat (its `probe`
 * query). The lobby uses it to offer a rejoin only while the other person is
 * still there.
 *
 * A relay from before the probe existed refuses it as a bad user id, and an
 * unreachable one never answers; both come back as `unknown`, which the lobby
 * treats as "could not check" rather than "nobody there".
 */

export type Presence =
  | { kind: 'there'; others: string[] }
  | { kind: 'empty' }
  | { kind: 'unknown' };

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
      resolve({ kind: 'unknown' });
      return;
    }
    let settled = false;
    const finish = (p: Presence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onmessage = socket.onclose = socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      resolve(p);
    };
    const timer = setTimeout(() => finish({ kind: 'unknown' }), PROBE_TIMEOUT_MS);
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
      finish({ kind: 'unknown' });
    };
    socket.onclose = () => finish({ kind: 'unknown' });
    socket.onerror = () => finish({ kind: 'unknown' });
  });
}
