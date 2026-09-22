'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  LAST_ROOM_TTL_MS,
  clearLastRoom,
  getLastRoomServerSnapshot,
  getLastRoomSnapshot,
  parseLastRoom,
  subscribeConfig,
} from '@/lib/relayConfig';
import { probePresence, type Presence } from '@/lib/sync/presence';
import { nameOf, useRuya } from '@/lib/store';

/** Asked again this often while the lobby is open, so the card follows them. */
const RECHECK_MS = 8_000;

/**
 * The room you were last in, offered back after a refresh, a crash or a closed
 * tab — but only while the other person is still in it. The relay is asked who
 * is there without taking a seat, so checking never shows up on their side.
 */
export function RejoinCard() {
  const raw = useSyncExternalStore(subscribeConfig, getLastRoomSnapshot, getLastRoomServerSnapshot);
  const last = useMemo(() => parseLastRoom(raw), [raw]);
  const startSession = useRuya((s) => s.startSession);
  // Keyed by room code, so an answer about a room we have since left is ignored.
  const [answer, setAnswer] = useState<{ code: string; presence: Presence } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!last) return;
    if (Date.now() - last.at > LAST_ROOM_TTL_MS) {
      clearLastRoom();
      return;
    }
    let cancelled = false;
    const check = () =>
      probePresence(last.relayUrl, last.code, last.userId).then((presence) => {
        if (!cancelled) setAnswer({ code: last.code, presence });
      });
    void check();
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [last]);

  const presence = last && answer?.code === last.code ? answer.presence : null;

  const rejoin = async () => {
    if (!last) return;
    setBusy(true);
    try {
      await startSession({
        roomCode: last.code,
        displayName: last.displayName,
        // A guess the relay corrects: the saved userId gets back whichever
        // seat it held, authority included.
        isAuthority: false,
        relayUrl: last.relayUrl,
        userId: last.userId,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence initial={false}>
      {last && presence && (
        <motion.div
          key={last.code}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
          className="overflow-hidden"
        >
          <div
            className={`rounded border px-5 py-4 ${
              presence.kind === 'there' ? 'border-gold/45' : 'border-line'
            }`}
          >
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-kicker">
                last room · {last.code}
              </p>
              <button
                type="button"
                onClick={clearLastRoom}
                aria-label="Forget this room"
                className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10px] uppercase tracking-[0.16em] text-faint transition-colors duration-300 hover:text-foreground"
              >
                forget
              </button>
            </div>
            <p className="font-display text-xl">
              {presence.kind === 'there' && (
                <>
                  <span className="text-gold-hi">{nameOf(presence.others[0])}</span> is still there.
                </>
              )}
              {presence.kind === 'empty' && <span className="text-muted">Nobody is there any more.</span>}
              {presence.kind === 'unreachable' && (
                <span className="text-muted">That relay is not answering.</span>
              )}
              {presence.kind === 'unsupported' && (
                <span className="text-muted">This relay cannot say who is there.</span>
              )}
            </p>
            {presence.kind !== 'empty' && (
              <button
                type="button"
                onClick={rejoin}
                disabled={busy}
                className={`mt-3.5 w-full cursor-pointer rounded border bg-transparent px-4 py-2.5 font-display text-base font-semibold transition-[background-color,border-color,color,transform,opacity] duration-500 active:scale-[.985] ${
                  presence.kind === 'there'
                    ? 'border-gold text-gold-hi hover:bg-gold/15 hover:text-foreground'
                    : 'border-line-strong text-foreground hover:border-gold hover:text-gold-hi'
                }`}
              >
                {busy ? 'Rejoining…' : `Rejoin as ${last.displayName}`}
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
