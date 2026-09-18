'use client';

import { useEffect, useRef, useState } from 'react';
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
  const position = useRuya((s) => s.status?.position ?? 0);
  const sendChat = useRuya((s) => s.sendChat);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const them = nameOf(peerUserId);

  // Keep the newest line in view as they arrive.
  useEffect(() => {
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
    <div className="flex h-full w-full flex-col sm:w-[348px] [animation:ry-slide-l_.5s_cubic-bezier(.2,.8,.2,1)_both]">
      <div className="flex-none border-b border-line px-[22px] pb-4 pt-[22px]">
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

      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] py-5"
      >
        {messages.length === 0 && (
          <p className="my-auto text-center font-display text-[17px] italic leading-[1.55] text-faint">
            Nothing said yet. Whatever you type is stamped with the moment in the film.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[88%] rounded border px-[13px] py-2.5 [animation:ry-bubble_.45s_cubic-bezier(.2,.8,.2,1)_both] ${
              m.mine
                ? 'self-end border-foreground/15'
                : 'self-start border-gold/30 border-l-2 border-l-gold/75'
            }`}
          >
            <div className="mb-[7px] flex justify-between gap-3.5 font-mono text-[9px] uppercase tracking-[0.17em]">
              <span className={m.mine ? 'text-muted' : 'text-gold-hi'}>{m.mine ? 'you' : them}</span>
              {m.position !== null && (
                <span className="tabular-nums text-dim">{formatClock(m.position)}</span>
              )}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-[1.62]">{m.text}</p>
          </div>
        ))}
      </div>

      <div className="flex-none border-t border-line px-[22px] pb-5 pt-4">
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

/**
 * While the aside is collapsed or fullscreen hides it, what arrives floats in
 * bottom-right, above the control bar when that is showing. Clicking one is
 * the way to answer: it leaves fullscreen, opens the aside and puts the cursor
 * in the reply box.
 */
export function ChatToasts({ barVisible }: { barVisible: boolean }) {
  const toasts = useRuya((s) => s.chatToasts);
  const peerUserId = useRuya((s) => s.peerUserId);
  const setChatOpen = useRuya((s) => s.setChatOpen);
  if (toasts.length === 0) return null;
  const them = nameOf(peerUserId);

  const openChat = async () => {
    useRuya.setState({ chatToasts: [] });
    setChatOpen(true);
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Already on its way out; the aside opens either way.
      }
    }
    // The aside mounts its column on the next render.
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('aside[aria-label="Chat"] :is(input, textarea)')?.focus();
    });
  };

  return (
    <div
      className="pointer-events-none absolute right-[26px] z-10 flex flex-col items-end gap-2.5 transition-[bottom] duration-[550ms] ease-[cubic-bezier(.2,.8,.2,1)]"
      style={{ bottom: barVisible ? 132 : 26 }}
    >
      {toasts.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => void openChat()}
          aria-label={`Message from ${them}: ${c.text}. Open chat`}
          className="pointer-events-auto block w-[min(320px,74vw)] cursor-pointer rounded border border-gold/45 border-l-2 border-l-gold bg-[rgba(20,19,18,0.92)] px-[15px] py-3 text-left text-foreground shadow-[0_14px_40px_rgba(11,11,10,0.55)] backdrop-blur-md transition-[border-color,background-color] duration-300 hover:border-gold hover:bg-[rgba(28,26,24,0.96)] [animation:ry-msg_5.4s_cubic-bezier(.2,.8,.2,1)_both]"
        >
          <span className="mb-[7px] flex justify-between gap-3 font-mono text-[9px] uppercase tracking-[0.18em]">
            <span className="text-gold-hi">{them}</span>
            {c.position !== null && (
              <span className="tabular-nums text-dim">{formatClock(c.position)}</span>
            )}
          </span>
          <span className="block break-words text-sm leading-[1.6]">{c.text}</span>
        </button>
      ))}
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
