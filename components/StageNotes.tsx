'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from '@/lib/player/fingerprint';
import { resumePoint, savePosition } from '@/lib/player/resume';
import { binMoments, favourite, topMoments } from '@/lib/moments';
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

/**
 * Both of you sent the same reaction at once: one big copy in the middle, a
 * ring going out from it on each side, and the word for it. Takes no clicks.
 */
export function TogetherMoment() {
  const together = useRuya((s) => s.together);
  const reduceMotion = useReducedMotion();
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center">
      <AnimatePresence>
        {together && (
          <motion.div
            key={together.id}
            className="relative flex flex-col items-center"
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 1.15, transition: { duration: 0.5 } }}
            transition={{ type: 'spring', stiffness: 260, damping: 16 }}
          >
            {!reduceMotion &&
              [0, 0.18].map((delay) => (
                <motion.span
                  key={delay}
                  className="absolute left-1/2 top-[70px] h-[140px] w-[140px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-gold-hi"
                  initial={{ opacity: 0.8, scale: 0.6 }}
                  animate={{ opacity: 0, scale: 2.4 }}
                  transition={{ duration: 1.3, delay, ease: 'easeOut' }}
                />
              ))}
            <span className="text-[120px] leading-[140px] drop-shadow-[0_10px_30px_rgba(0,0,0,0.6)]">
              {together.emoji}
            </span>
            <span className="mt-2 font-mono text-[11px] uppercase tracking-[0.3em] text-gold-hi drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
              together
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Stretches the recap looks for moments in; coarser than the seek bar's. */
const RECAP_BINS = 40;

/**
 * When the film ends: the moments you both reacted to most, each person's
 * favourite reaction, and how much was said. Worked out on each side from the
 * same session log, so both see the same card with "you" and "them" swapped.
 * Jumping to a moment is an ordinary seek, so both players go.
 */
export function Recap() {
  const status = useRuya((s) => s.status);
  const moments = useRuya((s) => s.moments);
  const messages = useRuya((s) => s.messages);
  const matches = useRuya((s) => s.matches);
  const peerUserId = useRuya((s) => s.peerUserId);
  // Keyed by the duration, so a new film brings it back; any play hides it.
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);

  const duration = status?.duration ?? 0;
  const ended = !!status && duration > 0 && !status.playing && status.position >= duration - 1;
  const lines = messages.filter((m) => !m.hold);
  const top = useMemo(
    () =>
      topMoments(
        binMoments(
          moments,
          lines.filter((m) => m.position !== null).map((m) => m.position as number),
          duration,
          RECAP_BINS,
        ),
        3,
      ),
    [moments, lines, duration],
  );
  if (!ended && dismissedFor !== null) setDismissedFor(null);
  const visible = ended && dismissedFor !== duration;

  const them = nameOf(peerUserId);
  const mine = moments.filter((m) => m.mine);
  const theirs = moments.filter((m) => !m.mine);
  const people = [
    { who: 'you', fav: favourite(mine), copies: mine.reduce((n, m) => n + m.count, 0), said: lines.filter((m) => m.mine).length },
    { who: them, fav: favourite(theirs), copies: theirs.reduce((n, m) => n + m.count, 0), said: lines.filter((m) => !m.mine).length },
  ];

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="recap"
          role="dialog"
          aria-label="Recap"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10, transition: { duration: 0.25 } }}
          transition={{ type: 'spring', stiffness: 260, damping: 28, delay: 0.6 }}
          className="absolute left-1/2 top-1/2 z-[8] max-h-[calc(100%-48px)] w-[min(440px,calc(100%-32px))] overflow-y-auto rounded border border-gold/40 bg-[rgba(20,19,18,0.95)] px-7 py-6 backdrop-blur-md [scrollbar-width:none]"
          style={{ x: '-50%', y: '-50%' }}
        >
          <p className="kicker mb-1.5">the end</p>
          <p className="mb-5 font-display text-[30px] font-light italic leading-tight">Watched together.</p>

          <div className="mb-5 grid grid-cols-2 gap-4 border-y border-line-soft py-4">
            {people.map((p) => (
              <div key={p.who}>
                <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.18em] text-faint">{p.who}</p>
                <p className="mb-1 font-display text-[22px]">
                  {p.fav ? (
                    <>
                      {p.fav.emoji}
                      <span className="ml-1.5 font-mono text-[11px] text-muted">×{p.fav.copies}</span>
                    </>
                  ) : (
                    <span className="text-[15px] italic text-muted">no reactions</span>
                  )}
                </p>
                <p className="font-mono text-[10.5px] tabular-nums text-muted">
                  {p.copies} {p.copies === 1 ? 'reaction' : 'reactions'} · {p.said} {p.said === 1 ? 'line' : 'lines'}
                </p>
              </div>
            ))}
          </div>

          {matches.length > 0 && (
            <p className="mb-4 font-display text-[16px] text-muted">
              You reacted <span className="text-gold-hi">together</span> {matches.length}{' '}
              {matches.length === 1 ? 'time' : 'times'}
              <span className="ml-2">{[...new Set(matches.map((m) => m.emoji))].slice(0, 5).join('')}</span>
            </p>
          )}

          {top.length > 0 && (
            <>
              <p className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-faint">the moments</p>
              <ul className="mb-5 flex flex-col gap-1">
                {top.map((b) => (
                  <li key={b.index}>
                    <button
                      type="button"
                      onClick={() => {
                        getEngine()?.seek(Math.max(0, b.first - 3));
                        setDismissedFor(duration);
                      }}
                      className="flex w-full cursor-pointer items-center gap-3 rounded border-0 bg-transparent px-2 py-1.5 text-left transition-colors duration-200 hover:bg-foreground/5"
                    >
                      <span className="w-12 font-mono text-[12px] tabular-nums text-gold-hi">{formatClock(b.first)}</span>
                      <span className="text-[17px]">{b.emoji.slice(0, 4).map(([e]) => e).join(' ')}</span>
                      {b.lines > 0 && (
                        <span className="ml-auto font-mono text-[10.5px] text-muted">
                          {b.lines} {b.lines === 1 ? 'line' : 'lines'}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <button
            type="button"
            onClick={() => setDismissedFor(duration)}
            className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors duration-300 hover:text-foreground"
          >
            close
          </button>
        </motion.div>
      )}
    </AnimatePresence>
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

/** How often the position is written while playing. */
const SAVE_EVERY_MS = 5_000;

/**
 * Remembers where this film was left and, at the start of a session, offers
 * to go back there. Continuing is an ordinary seek, so both players go.
 */
export function ResumePrompt() {
  const fingerprint = useRuya((s) => s.fingerprint);
  const position = useRuya((s) => s.status?.position ?? 0);
  const duration = useRuya((s) => s.status?.duration ?? 0);
  const playing = useRuya((s) => s.status?.playing ?? false);
  const showToast = useRuya((s) => s.showToast);
  // Read once per film: the offer is about the last session, not this one.
  const [offer, setOffer] = useState<{ fp: string; at: number | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const lastSave = useRef(0);

  const at = fingerprint && offer?.fp === fingerprint ? offer.at : null;
  if (fingerprint && offer?.fp !== fingerprint) {
    setOffer({ fp: fingerprint, at: resumePoint(fingerprint) });
  }

  useEffect(() => {
    if (!fingerprint || !duration) return;
    const now = performance.now();
    // Every few seconds while playing, and whenever it stops.
    if (!playing || now - lastSave.current > SAVE_EVERY_MS) {
      lastSave.current = now;
      // Not the opening seconds: a fresh start must not wipe a real resume point.
      if (position > 15) savePosition(fingerprint, position, duration);
    }
  }, [fingerprint, position, duration, playing]);

  // Past the opening, the moment has gone either way.
  const visible = at !== null && !dismissed && position < 10;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="resume"
          role="dialog"
          aria-label="Resume"
          initial={{ opacity: 0, y: 16 }}
          // Held back until the opening beat has cleared the screen.
          animate={{
            opacity: 1,
            y: 0,
            transition: { type: 'spring', stiffness: 300, damping: 30, delay: 2.8 },
          }}
          exit={{ opacity: 0, y: 10, transition: { duration: 0.2 } }}
          className="absolute bottom-[150px] left-[clamp(16px,3vw,32px)] z-[8] w-[min(320px,calc(100%-32px))] rounded border border-gold/40 bg-[rgba(20,19,18,0.94)] px-5 py-4 backdrop-blur-md"
        >
          <p className="kicker mb-1.5">pick up where you left off</p>
          <p className="mb-3.5 font-display text-[26px] font-light tabular-nums">
            {formatClock(at)}
          </p>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => {
                getEngine()?.seek(at);
                showToast(`Jump to ${formatClock(at)}`);
                setDismissed(true);
              }}
              className="cursor-pointer rounded border border-gold bg-transparent px-4 py-1.5 font-display text-[15px] font-semibold text-gold-hi transition-colors duration-300 hover:bg-gold/15"
            >
              Continue for both
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors duration-300 hover:text-foreground"
            >
              start over
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
