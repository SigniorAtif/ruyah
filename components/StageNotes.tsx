'use client';

import { AnimatePresence, motion } from 'motion/react';
import { getEngine, nameOf, useRuya } from '@/lib/store';

/**
 * Reactions rise from the lower third and fade, yours toward the right and
 * theirs toward the left, so a burst from both sides reads as a conversation.
 * Nothing here takes clicks.
 */
export function FloatingReactions() {
  const reactions = useRuya((s) => s.reactions);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[6] overflow-hidden">
      <AnimatePresence>
        {reactions.map((r) => {
          // Spread by id rather than Math.random, so a re-render never moves one.
          const lane = ((r.id * 37) % 18) - 9;
          const left = (r.mine ? 62 : 38) + lane;
          return (
            <motion.span
              key={r.id}
              className="absolute bottom-[22%] text-[42px] drop-shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
              style={{ left: `${left}%` }}
              initial={{ opacity: 0, y: 30, scale: 0.4 }}
              animate={{
                opacity: [0, 1, 1, 0],
                y: -240,
                scale: [0.4, 1.25, 1, 0.9],
                x: [0, lane * 2, -lane, lane],
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
