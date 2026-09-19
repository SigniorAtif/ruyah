'use client';

import { AnimatePresence, motion } from 'motion/react';
import { getEngine, nameOf, SCATTER_ABOVE, useRuya } from '@/lib/store';

/**
 * A burst of up to SCATTER_ABOVE rises from random spots in the bottom 15% of
 * the screen. A bigger one lands all over the screen and rocks to and fro in
 * place. Spots are picked in the store when each is pushed, so a re-render
 * never moves one. Nothing here takes clicks.
 */
export function FloatingReactions() {
  const reactions = useRuya((s) => s.reactions);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[6] overflow-hidden">
      <AnimatePresence>
        {reactions.map((r) => {
          const style = { left: `${r.x}%`, bottom: `${r.y}%` };
          if (r.burst > SCATTER_ABOVE) {
            // Alternate which way each one rocks first, so the screen does not sway as one.
            const dir = r.id % 2 === 0 ? 1 : -1;
            return (
              <motion.span
                key={r.id}
                className="absolute -translate-x-1/2 text-[42px] drop-shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
                style={style}
                initial={{ opacity: 0, scale: 0.3, rotate: 0 }}
                animate={{
                  opacity: [0, 1, 1, 0],
                  scale: [0.3, 1.2, 1, 0.85],
                  rotate: [0, 18 * dir, -16 * dir, 14 * dir, -12 * dir, 8 * dir, 0],
                }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 2.5,
                  opacity: { duration: 2.5, times: [0, 0.12, 0.8, 1] },
                  scale: { duration: 2.5, times: [0, 0.15, 0.3, 1] },
                  rotate: { duration: 2.5, ease: 'easeInOut' },
                }}
              >
                {r.emoji}
              </motion.span>
            );
          }
          // A little side-to-side on the way up, by id rather than Math.random.
          const sway = ((r.id * 37) % 18) - 9;
          return (
            <motion.span
              key={r.id}
              className="absolute -translate-x-1/2 text-[42px] drop-shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
              style={style}
              initial={{ opacity: 0, y: 30, scale: 0.4 }}
              animate={{
                opacity: [0, 1, 1, 0],
                y: -240,
                scale: [0.4, 1.25, 1, 0.9],
                x: [0, sway * 2, -sway, sway],
              }}
              exit={{ opacity: 0 }}
              transition={{ duration: 2.5, ease: 'easeOut', times: [0, 0.15, 0.7, 1] }}
            >
              {r.emoji}
            </motion.span>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/** While a hold-on pause is in force: who asked, why, and a way back in. */
export function HoldBanner() {
  const hold = useRuya((s) => s.hold);
  const peerUserId = useRuya((s) => s.peerUserId);
  return (
    <AnimatePresence>
      {hold && (
        <motion.div
          key="hold"
          role="status"
          initial={{ opacity: 0, y: -14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          className="absolute left-1/2 top-6 z-[7] flex max-w-[calc(100%-32px)] items-center gap-4 rounded border border-warn/40 bg-stage/85 px-5 py-3 backdrop-blur-md"
          style={{ x: '-50%' }}
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-warn">
            {hold.mine ? 'you' : nameOf(peerUserId)} · hold on
          </span>
          {hold.reason !== 'hold on' && (
            <span className="truncate font-display text-[18px] italic text-foreground/85">
              {hold.reason}
            </span>
          )}
          <button
            type="button"
            onClick={() => getEngine()?.play()}
            className="flex-none cursor-pointer rounded border border-gold bg-transparent px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-gold-hi transition-colors duration-300 hover:bg-gold/15"
          >
            {hold.mine ? 'back' : 'resume'}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
