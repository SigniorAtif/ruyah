'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatClock } from '@/lib/player/fingerprint';
import { CHAT_MAX_CHARS, nameOf, useRuya } from '@/lib/store';

/**
 * The aside beside the film. Open it is a narrow column of what was said, each
 * line stamped with the moment in the film; collapsed it is a rail that only
 * counts what arrived, while the lines float over the film (see ChatToasts).
 * Fullscreen takes the stage alone, so there they float too.
 */
export function ChatAside() {
  const open = useRuya((s) => s.chatOpen);
  const unread = useRuya((s) => s.unread);
  const setChatOpen = useRuya((s) => s.setChatOpen);
  const [railHover, setRailHover] = useState(false);

  // Lines that arrived in fullscreen counted as unread even with the aside
  // open; coming back out is when they become visible again.
  useEffect(() => {
    const onFullscreen = () => {
      const { chatOpen } = useRuya.getState();
      if (!document.fullscreenElement && chatOpen) setChatOpen(true);
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, [setChatOpen]);

  return (
    <aside
      aria-label="Chat"
      className={`relative z-20 h-full flex-none overflow-hidden border-l border-line bg-background transition-[width] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] ${
        open
          ? 'w-[348px] max-sm:absolute max-sm:inset-y-0 max-sm:right-0 max-sm:w-full'
          : 'w-[54px]'
      }`}
    >
      {open ? (
        <ChatColumn onCollapse={() => setChatOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          onMouseEnter={() => setRailHover(true)}
          onMouseLeave={() => setRailHover(false)}
          aria-label={unread > 0 ? `Open chat, ${unread} unread` : 'Open chat'}
          className={`flex h-full w-full cursor-pointer flex-col items-center justify-between border-0 bg-transparent px-0 py-6 transition-colors duration-[350ms] [animation:ry-in-soft_.45s_ease_both] ${
            railHover || unread > 0 ? 'text-gold-hi' : 'text-muted'
          }`}
        >
          <ChatIcon />
          <span className="font-mono text-[10px] uppercase tracking-[0.26em] [writing-mode:vertical-rl]">
            chat
          </span>
          {unread > 0 ? (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-gold bg-gold/20 px-[5px] font-mono text-[10.5px] tabular-nums text-gold-hi [animation:ry-pop_.4s_cubic-bezier(.2,.8,.2,1)_both]">
              {unread}
            </span>
          ) : (
            <span className="h-1 w-1 rounded-full bg-foreground/20" />
          )}
        </button>
      )}
    </aside>
  );
}

function ChatColumn({ onCollapse }: { onCollapse: () => void }) {
  const roomCode = useRuya((s) => s.roomCode);
  const me = useRuya((s) => s.displayName);
  const peerUserId = useRuya((s) => s.peerUserId);
  const messages = useRuya((s) => s.messages);
  const landed = useRuya((s) => s.chatLanded);
  const position = useRuya((s) => s.status?.position ?? 0);
  const sendChat = useRuya((s) => s.sendChat);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const them = nameOf(peerUserId);

  // Keep the newest line in view as they arrive. A layout effect, so the list
  // is already scrolled when Motion measures where a flying toast should land.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const canSend = draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    sendChat(draft);
    setDraft('');
  };

  return (
    // Pinned to the aside's right edge at full width, so the aside's width
    // transition reveals it rather than moving it. Every line is already where
    // it will end up the moment it mounts, which is what lets a toast fly to
    // it while the aside is still opening. For the same reason only the header
    // and composer slide in: a transform on anything around the log would
    // throw off where Motion thinks a line is.
    <div className="absolute inset-y-0 right-0 flex w-full flex-col sm:w-[348px]">
      <div className="flex-none border-b border-line px-[22px] pb-4 pt-[22px] [animation:ry-slide-l_.5s_cubic-bezier(.2,.8,.2,1)_both]">
        <div className="flex items-baseline justify-between gap-3.5">
          <div className="min-w-0">
            <p className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.22em] text-kicker">
              aside · room {roomCode}
            </p>
            <h4 className="truncate font-display text-[25px] font-light leading-[1.1]">
              {me || 'You'} &amp; {them}
            </h4>
          </div>
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse"
            aria-label="Collapse chat"
            className="flex cursor-pointer border-0 bg-transparent p-1 text-faint transition-[color,transform] duration-300 hover:translate-x-[3px] hover:text-gold-hi"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
        <div className="mt-3.5 h-px w-[38px] bg-gold" />
      </div>

      {/* layoutScroll: a line flying in from a toast is measured inside this
          scroller, so its scroll offset has to be accounted for. */}
      <motion.div
        ref={listRef}
        layoutScroll
        role="log"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] py-5"
      >
        {messages.length === 0 && (
          <p className="my-auto text-center font-display text-[17px] italic leading-[1.55] text-faint">
            Nothing said yet. Whatever you type is stamped with the moment in the film.
          </p>
        )}
        {messages.map((m) => {
          const flewIn = landed.includes(m.id);
          return (
            <motion.div
              key={flewIn ? `${m.id}-landed` : m.id}
              // Shares its layoutId with the toast it came from, so Motion morphs
              // one into the other. The CSS entrance would fight that transform.
              layoutId={flewIn ? chatLayoutId(m.id) : undefined}
              // The toast is gone the instant this takes over, so there is
              // nothing to crossfade with.
              layoutCrossfade={false}
              transition={HANDOFF_SPRING}
              className={`max-w-[88%] rounded border px-[13px] py-2.5 ${
                flewIn ? '' : '[animation:ry-bubble_.45s_cubic-bezier(.2,.8,.2,1)_both]'
              } ${
                m.mine
                  ? 'self-end border-foreground/15'
                  : 'self-start border-gold/30 border-l-2 border-l-gold/75'
              }`}
            >
              {/* `layout` on the contents undoes the parent's scale in flight, so
                  the text keeps its shape while the box morphs from toast to line. */}
              <motion.div
                layout={flewIn}
                transition={HANDOFF_SPRING}
                className="mb-[7px] flex justify-between gap-3.5 font-mono text-[9px] uppercase tracking-[0.17em]"
              >
                <span className={m.mine ? 'text-muted' : 'text-gold-hi'}>
                  {m.mine ? 'you' : them}
                </span>
                {m.position !== null && (
                  <span className="tabular-nums text-dim">{formatClock(m.position)}</span>
                )}
              </motion.div>
              <motion.p
                layout={flewIn}
                transition={HANDOFF_SPRING}
                className="whitespace-pre-wrap break-words text-sm leading-[1.62]"
              >
                {m.text}
              </motion.p>
            </motion.div>
          );
        })}
      </motion.div>

      <div className="flex-none border-t border-line px-[22px] pb-5 pt-4 [animation:ry-slide-l_.5s_cubic-bezier(.2,.8,.2,1)_both]">
        <div className="flex items-end gap-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Say something"
            maxLength={CHAT_MAX_CHARS}
            aria-label="Message"
            className="min-w-0 flex-1 border-0 border-b border-line-strong bg-transparent px-0.5 py-[9px] font-serif text-[14.5px] text-foreground transition-colors duration-[350ms] focus:border-gold"
          />
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className={`cursor-pointer rounded border bg-transparent px-[13px] py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-[background-color,border-color,color,transform] duration-[350ms] hover:bg-gold/15 hover:text-foreground active:scale-[.97] ${
              canSend ? 'border-gold text-gold-hi' : 'border-foreground/20 text-faint'
            }`}
          >
            send
          </button>
        </div>
        <div className="mt-3 flex justify-between gap-3 font-mono text-[9.5px] uppercase tracking-[0.14em] text-dim">
          <span className="tabular-nums">stamped {formatClock(position)}</span>
          <span>enter to send · c hides</span>
        </div>
      </div>
    </div>
  );
}

const chatLayoutId = (id: number) => `chat-line-${id}`;

/** One spring for the toast-to-aside flight, on both ends of it. */
const HANDOFF_SPRING = {
  type: 'spring',
  stiffness: 260,
  damping: 30,
  mass: 0.9,
} as const;

/**
 * A toast's exit. AnimatePresence hands the exiting toast the id being flown
 * into the aside; that one vanishes on the spot, because its line has already
 * taken over from exactly where it was. The rest slide off as usual.
 */
const toastExit = (id: number) => (handoffId: number | null) =>
  handoffId === id ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: 14 };

/** Longer than Motion's post-resize hold on layout animations (250ms). */
const RESIZE_SETTLE_MS = 300;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * While the aside is collapsed or fullscreen hides it, what arrives floats in
 * bottom-right, above the control bar when that is showing.
 *
 * Clicking one is the way to answer. It leaves fullscreen first, then opens
 * the aside and hands the toast over in the same moment: toast and line share
 * a layoutId, so the toast flies into its place in the conversation while the
 * aside opens around it.
 */
export function ChatToasts({ barVisible }: { barVisible: boolean }) {
  const toasts = useRuya((s) => s.chatToasts);
  const peerUserId = useRuya((s) => s.peerUserId);
  const them = nameOf(peerUserId);
  // The toast being flown into the aside. It hands over to its line at once
  // instead of fading: the aside's widening moves the whole stage, and a
  // fading copy left behind would drift away from the line in flight.
  const [handoffId, setHandoffId] = useState<number | null>(null);

  const openChat = async (id: number) => {
    if (useRuya.getState().chatHandoffPending) return;
    setHandoffId(id);
    // Holds the toasts on screen through the fullscreen exit; setChatOpen
    // (called when fullscreen ends) would otherwise clear them straight away.
    useRuya.setState({ chatHandoffPending: true });
    if (document.fullscreenElement) {
      // Out of fullscreen first, and only then the animation: the page has to
      // be at its windowed size before anything is measured.
      await new Promise<void>((resolve) => {
        const done = () => {
          document.removeEventListener('fullscreenchange', done);
          resolve();
        };
        document.addEventListener('fullscreenchange', done);
        document.exitFullscreen().catch(done);
      });
      // Motion holds layout animations back briefly after a window resize,
      // and leaving fullscreen is one. Give it that moment, or the flight is
      // skipped and the line just appears.
      await new Promise((r) => setTimeout(r, RESIZE_SETTLE_MS));
    }

    // One update, so both animations start on the same frame: the aside
    // widens (CSS) while the toast leaves and its line mounts under the same
    // layoutId, which Motion morphs between.
    useRuya.setState((s) => ({
      chatOpen: true,
      unread: 0,
      chatToasts: [],
      chatHandoffPending: false,
      chatLanded: s.messages.some((m) => m.id === id)
        ? [...s.chatLanded.filter((x) => x !== id), id].slice(-50)
        : s.chatLanded,
    }));

    await nextFrame();
    document.querySelector<HTMLElement>('aside[aria-label="Chat"] :is(input, textarea)')?.focus();
  };

  return (
    <div
      className="pointer-events-none absolute right-[26px] z-10 flex flex-col items-end gap-2.5 transition-[bottom] duration-[550ms] ease-[cubic-bezier(.2,.8,.2,1)]"
      style={{ bottom: barVisible ? 132 : 26 }}
    >
      <AnimatePresence custom={handoffId}>
        {toasts.map((c) => (
          <motion.button
            key={c.id}
            layoutId={chatLayoutId(c.id)}
            type="button"
            onClick={() => void openChat(c.id)}
            aria-label={`Message from ${them}: ${c.text}. Open chat`}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            variants={{ exit: toastExit(c.id) }}
            custom={handoffId}
            exit="exit"
            transition={HANDOFF_SPRING}
            className="pointer-events-auto block w-[min(320px,74vw)] cursor-pointer rounded border border-gold/45 border-l-2 border-l-gold bg-[rgba(20,19,18,0.92)] px-[15px] py-3 text-left text-foreground shadow-[0_14px_40px_rgba(11,11,10,0.55)] backdrop-blur-md transition-[border-color,background-color] duration-300 hover:border-gold hover:bg-[rgba(28,26,24,0.96)]"
          >
            <span className="mb-[7px] flex justify-between gap-3 font-mono text-[9px] uppercase tracking-[0.18em]">
              <span className="text-gold-hi">{them}</span>
              {c.position !== null && (
                <span className="tabular-nums text-dim">{formatClock(c.position)}</span>
              )}
            </span>
            <span className="block break-words text-sm leading-[1.6]">{c.text}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden
    >
      <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.4-4.2A8 8 0 0 1 13 4a8 8 0 0 1 8 8z" />
    </svg>
  );
}
