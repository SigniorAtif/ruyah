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

  // Only shown when the relay says someone is in there: an empty room, a relay
  // that is down and a relay too old to answer all look the same from here —
  // nobody to go back to — and the check runs again every few seconds, so the
  // card appears by itself if they turn up.
  const there = presence?.kind === 'there' ? presence : null;

  return (
    <AnimatePresence initial={false}>
      {last && there && (
        <motion.div
          key={last.code}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
          className="overflow-hidden"
        >
          <div className="rounded border border-gold/45 px-5 py-4">
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
              <span className="text-gold-hi">{nameOf(there.others[0])}</span> is still there.
            </p>
            <button
              type="button"
              onClick={rejoin}
              disabled={busy}
              className="mt-3.5 w-full cursor-pointer rounded border border-gold bg-transparent px-4 py-2.5 font-display text-base font-semibold text-gold-hi transition-[background-color,color,transform,opacity] duration-500 hover:bg-gold/15 hover:text-foreground active:scale-[.985]"
            >
              {busy ? 'Rejoining…' : `Rejoin as ${last.displayName}`}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
