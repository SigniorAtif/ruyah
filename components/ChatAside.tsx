'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { EMOJI_GROUPS, searchEmoji } from '@/lib/emoji';
import {
  getQuickEmojiServerSnapshot,
  getQuickEmojiSnapshot,
  recordEmojiUse,
  subscribeEmojiUse,
} from '@/lib/emojiUse';
import { formatClock } from '@/lib/player/fingerprint';
import {
  parseSticker,
  searchStickers,
  stickerToken,
  type Sticker,
} from '@/lib/stickers';
import {
  CHAT_MAX_CHARS,
  getEngine,
  nameOf,
  useRuya,
  type ChatMessage,
} from '@/lib/store';

/** What a sticker line reads as where it is not drawn: a reply quote, a label. */
function lineLabel(text: string): string {
  const sticker = parseSticker(text);
  return sticker ? `sticker · ${sticker.label}` : text;
}

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

/** A typing notice goes out at most this often while someone keeps typing. */
const TYPING_EVERY_MS = 2_500;

function ChatColumn({ onCollapse }: { onCollapse: () => void }) {
  const roomCode = useRuya((s) => s.roomCode);
  const me = useRuya((s) => s.displayName);
  const peerUserId = useRuya((s) => s.peerUserId);
  const messages = useRuya((s) => s.messages);
  const landed = useRuya((s) => s.chatLanded);
  const peerTyping = useRuya((s) => s.peerTyping);
  const position = useRuya((s) => s.status?.position ?? 0);
  const sendChat = useRuya((s) => s.sendChat);
  const sendTyping = useRuya((s) => s.sendTyping);
  const [draft, setDraft] = useState('');
  // The film time when this line was started. A line is about the moment the
  // person began writing it, not the moment they finished.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  /** Which tray is open over the composer, if either. */
  const [tray, setTray] = useState<'emoji' | 'stickers' | null>(null);
  /** The quick row: their own most-picked emoji, seeded until they have picked any. */
  const quickEmoji = useSyncExternalStore(
    subscribeEmojiUse,
    getQuickEmojiSnapshot,
    getQuickEmojiServerSnapshot,
  );
  const lastTypingSent = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const them = nameOf(peerUserId);

  // Keep the newest line in view as they arrive. A layout effect, so the list
  // is already scrolled when Motion measures where a flying toast should land.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, peerTyping]);

  const onDraft = (value: string) => {
    setDraft(value);
    if (!value.trim()) {
      setStartedAt(null);
      return;
    }
    if (startedAt === null) setStartedAt(getEngine()?.getStatus().position ?? position);
    const now = performance.now();
    if (now - lastTypingSent.current > TYPING_EVERY_MS) {
      lastTypingSent.current = now;
      sendTyping();
    }
  };

  const canSend = draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    sendChat(draft, { position: startedAt ?? undefined, replyTo: replyTo?.wireId });
    setDraft('');
    setStartedAt(null);
    setReplyTo(null);
    lastTypingSent.current = 0;
  };

  const startReply = (m: ChatMessage) => {
    setReplyTo(m);
    inputRef.current?.focus();
  };

  /**
   * An emoji lands where the caret is, not at the end: picking one in the
   * middle of a sentence is the whole point of having the row there.
   */
  const insertEmoji = (emoji: string) => {
    recordEmojiUse(emoji);
    const el = inputRef.current;
    const at = el?.selectionStart ?? draft.length;
    const to = el?.selectionEnd ?? at;
    const next = (draft.slice(0, at) + emoji + draft.slice(to)).slice(0, CHAT_MAX_CHARS);
    onDraft(next);
    // After React has written the value back, or the caret jumps to the end.
    requestAnimationFrame(() => {
      const caret = Math.min(at + emoji.length, next.length);
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  /** A sticker is a line of its own: it goes the moment it is picked. */
  const sendSticker = (sticker: Sticker) => {
    sendChat(stickerToken(sticker.id), {
      position: startedAt ?? undefined,
      replyTo: replyTo?.wireId,
    });
    setReplyTo(null);
    setStartedAt(null);
    setTray(null);
  };

  /** Scroll to the line a reply points at and flash it, if it is still here. */
  const showOriginal = (wire: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-wire="${wire}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(wire);
    setTimeout(() => setFlashId((f) => (f === wire ? null : f)), 1_200);
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
          if (m.hold) return <HoldLine key={m.id} m={m} them={them} />;
          const flewIn = landed.includes(m.id);
          return (
            <motion.div
              key={flewIn ? `${m.id}-landed` : m.id}
              data-wire={m.wireId}
              // Shares its layoutId with the toast it came from, so Motion morphs
              // one into the other. The CSS entrance would fight that transform.
              layoutId={flewIn ? chatLayoutId(m.id) : undefined}
              // The toast is gone the instant this takes over, so there is
              // nothing to crossfade with.
              layoutCrossfade={false}
              transition={HANDOFF_SPRING}
              className={`group relative max-w-[88%] rounded border px-[13px] py-2.5 transition-[background-color] duration-700 ${
                flewIn ? '' : '[animation:ry-bubble_.45s_cubic-bezier(.2,.8,.2,1)_both]'
              } ${
                m.mine
                  ? 'self-end border-foreground/15'
                  : 'self-start border-gold/30 border-l-2 border-l-gold/75'
              } ${flashId === m.wireId ? 'bg-gold/15' : 'bg-transparent'}`}
            >
              {/* `layout` on the contents undoes the parent's scale in flight, so
                  the text keeps its shape while the box morphs from toast to line. */}
              <motion.div
                layout={flewIn}
                transition={HANDOFF_SPRING}
                className="mb-[7px] flex items-center justify-between gap-3.5 font-mono text-[9px] uppercase tracking-[0.17em]"
              >
                <span className={m.mine ? 'text-muted' : 'text-gold-hi'}>
                  {m.mine ? 'you' : them}
                </span>
                {m.position !== null && <Stamp position={m.position} />}
              </motion.div>
              {m.reply && (
                <motion.button
                  layout={flewIn}
                  transition={HANDOFF_SPRING}
                  type="button"
                  onClick={() => showOriginal(m.reply!.wireId)}
                  className="mb-2 block w-full cursor-pointer truncate rounded-sm border-0 border-l-2 border-l-foreground/25 bg-foreground/[0.04] px-2 py-1 text-left text-[12px] leading-[1.45] text-muted transition-colors duration-300 hover:text-foreground"
                >
                  <span className="mr-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
                    {m.reply.mine ? 'you' : them}
                  </span>
                  {lineLabel(m.reply.text)}
                </motion.button>
              )}
              {(() => {
                const sticker = parseSticker(m.text);
                return sticker ? (
                  <motion.img
                    layout={flewIn}
                    transition={HANDOFF_SPRING}
                    src={sticker.src}
                    alt={sticker.label}
                    draggable={false}
                    className="block h-[104px] w-auto select-none"
                  />
                ) : (
                  <motion.p
                    layout={flewIn}
                    transition={HANDOFF_SPRING}
                    className="whitespace-pre-wrap break-words text-sm leading-[1.62]"
                  >
                    {m.text}
                  </motion.p>
                );
              })()}
              <button
                type="button"
                onClick={() => startReply(m)}
                aria-label={`Reply to ${m.mine ? 'your' : `${them}'s`} message`}
                className={`absolute top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-foreground/15 bg-background text-faint opacity-0 transition-[opacity,color,border-color] duration-200 hover:border-gold hover:text-gold-hi focus-visible:opacity-100 group-hover:opacity-100 ${
                  m.mine ? '-left-8' : '-right-8'
                }`}
              >
                <ReplyIcon />
              </button>
            </motion.div>
          );
        })}
        <AnimatePresence>
          {peerTyping && (
            <motion.p
              key="typing"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-2 self-start font-mono text-[9.5px] uppercase tracking-[0.16em] text-faint"
            >
              <TypingDots />
              {them} is typing
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>

      <div className="relative flex-none border-t border-line px-[22px] pb-5 pt-4 [animation:ry-slide-l_.5s_cubic-bezier(.2,.8,.2,1)_both]">
        <AnimatePresence>
          {tray && (
            <>
              {/* Anywhere else closes it, including the film behind the aside. */}
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setTray(null)}
                className="fixed inset-0 z-10 cursor-default border-0 bg-transparent p-0"
              />
              <motion.div
                key={tray}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setTray(null);
                }}
                className="absolute bottom-full left-[22px] right-[22px] z-20 mb-2.5 rounded border border-line bg-[rgba(20,19,18,0.97)] p-2.5 shadow-[0_18px_48px_rgba(11,11,10,0.62)] backdrop-blur-md"
              >
                {tray === 'emoji' ? (
                  <EmojiTray onPick={insertEmoji} />
                ) : (
                  <StickerTray onPick={sendSticker} />
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {replyTo && (
            <motion.div
              key="reply"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ height: { type: 'spring', stiffness: 320, damping: 34 }, opacity: { duration: 0.2 } }}
              className="overflow-hidden"
            >
              <div className="mb-3 flex items-center gap-2.5 border-l-2 border-l-gold pl-2.5">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-kicker">
                    replying to {replyTo.mine ? 'yourself' : them}
                  </p>
                  <p className="truncate text-[12.5px] text-muted">{lineLabel(replyTo.text)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  aria-label="Cancel reply"
                  className="flex-none cursor-pointer border-0 bg-transparent p-1 font-mono text-[13px] text-faint transition-colors duration-300 hover:text-foreground"
                >
                  ×
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {/* The six this person actually uses, then the way to everything else. */}
        <div className="mb-2.5 flex items-center gap-0.5">
          {quickEmoji.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => insertEmoji(emoji)}
              aria-label={`Add ${emoji}`}
              className="cursor-pointer rounded border-0 bg-transparent px-[3px] py-0.5 text-[15px] leading-none opacity-65 transition-[opacity,transform] duration-200 hover:-translate-y-px hover:opacity-100"
            >
              {emoji}
            </button>
          ))}
          <span className="mx-1.5 h-3.5 w-px flex-none bg-line" />
          <TrayTab open={tray === 'emoji'} onClick={() => setTray((t) => (t === 'emoji' ? null : 'emoji'))}>
            emoji
          </TrayTab>
          <TrayTab
            open={tray === 'stickers'}
            onClick={() => setTray((t) => (t === 'stickers' ? null : 'stickers'))}
          >
            stickers
          </TrayTab>
        </div>
        <div className="flex items-end gap-3">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                send();
              }
              // A tray is the nearest thing open, so it goes first.
              if (e.key === 'Escape' && tray) {
                e.stopPropagation();
                setTray(null);
              }
            }}
            placeholder={replyTo ? 'Reply' : 'Say something'}
            maxLength={CHAT_MAX_CHARS}
            aria-label="Message"
            className="min-w-0 flex-1 border-0 border-b border-line-strong bg-transparent px-0.5 py-[9px] font-serif text-[14.5px] text-foreground caret-gold-hi outline-none transition-colors duration-500 focus:border-gold-hi"
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
          {/* Frozen once they start typing: that is the moment the line is about. */}
          <span className={`tabular-nums transition-colors duration-300 ${startedAt !== null ? 'text-kicker' : ''}`}>
            stamped {formatClock(startedAt ?? position)}
          </span>
          <span>enter to send · c hides</span>
        </div>
      </div>
    </div>
  );
}

function TrayTab({
  open,
  onClick,
  children,
}: {
  open: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={`cursor-pointer rounded-full border-0 px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.16em] transition-colors duration-200 ${
        open ? 'bg-gold/15 text-gold-hi' : 'bg-transparent text-faint hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Every emoji the reactions use, searchable, here to be written into a line
 * rather than thrown over the film. Sections are labelled but not tabbed: the
 * composer's tray is a third of the height of the one on the control bar, and
 * tabs in it would cost more room than the scrolling they save.
 */
function EmojiTray({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const results = query.trim() ? searchEmoji(query) : null;

  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) field.current?.focus();
  }, []);

  const cell = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      onClick={() => onPick(emoji)}
      aria-label={emoji}
      className="flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded border-0 bg-transparent text-[17px] leading-none transition-colors duration-150 hover:bg-foreground/10"
    >
      {emoji}
    </button>
  );

  return (
    <>
      <input
        ref={field}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search"
        aria-label="Search emoji"
        spellCheck={false}
        className="mb-1.5 w-full border-0 border-b border-line bg-transparent px-0.5 py-1 font-mono text-[11px] text-foreground caret-gold-hi outline-none transition-colors duration-300 placeholder:uppercase placeholder:tracking-[0.16em] focus:border-gold"
      />
      <div className="h-[168px] overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,black_88%,transparent)] [scrollbar-width:none]">
        {results ? (
          results.length ? (
            <div className="grid grid-cols-8">{results.map(cell)}</div>
          ) : (
            <p className="pt-5 text-center font-display text-[15px] italic text-muted">
              Nothing by that name.
            </p>
          )
        ) : (
          EMOJI_GROUPS.map((g, i) => (
            <section key={g.id} aria-label={g.label}>
              <p
                className={`pb-1 font-mono text-[9px] uppercase tracking-[0.18em] text-faint ${i ? 'pt-2' : ''}`}
              >
                {g.label}
              </p>
              <div className="grid grid-cols-8">{g.emoji.map(([e]) => cell(e))}</div>
            </section>
          ))
        )}
      </div>
    </>
  );
}

/** The stickers, which send themselves: there is nothing to add to one. */
function StickerTray({ onPick }: { onPick: (sticker: Sticker) => void }) {
  const [query, setQuery] = useState('');
  const results = searchStickers(query);

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search"
        aria-label="Search stickers"
        spellCheck={false}
        className="mb-1.5 w-full border-0 border-b border-line bg-transparent px-0.5 py-1 font-mono text-[11px] text-foreground caret-gold-hi outline-none transition-colors duration-300 placeholder:uppercase placeholder:tracking-[0.16em] focus:border-gold"
      />
      <div className="max-h-[186px] overflow-y-auto overscroll-contain [scrollbar-width:none]">
        {results.length ? (
          <div className="grid grid-cols-3 gap-1.5">
            {results.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s)}
                title={s.label}
                aria-label={`Send ${s.label}`}
                className="flex cursor-pointer items-center justify-center rounded border border-transparent bg-transparent p-1.5 transition-[background-color,border-color,transform] duration-200 hover:border-gold/40 hover:bg-gold/10 active:scale-95"
              >
                {/* A few KB of local PNG in a static export: there is no loader
                    to route it through, and nothing to optimise. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={s.src}
                  alt=""
                  draggable={false}
                  className="h-[60px] w-auto select-none"
                />
              </button>
            ))}
          </div>
        ) : (
          <p className="pt-5 text-center font-display text-[15px] italic text-muted">
            Nothing by that name.
          </p>
        )}
      </div>
      <p className="pt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-dim">
        a sticker sends on its own
      </p>
    </>
  );
}

/** A line's moment in the film. Clicking it takes both players there. */
function Stamp({ position }: { position: number }) {
  const showToast = useRuya((s) => s.showToast);
  return (
    <button
      type="button"
      onClick={() => {
        getEngine()?.seek(position);
        showToast(`Jump to ${formatClock(position)}`);
      }}
      title="Jump here"
      aria-label={`Jump to ${formatClock(position)}`}
      className="cursor-pointer border-0 bg-transparent p-0 font-mono tabular-nums tracking-[0.17em] text-dim underline decoration-transparent underline-offset-2 transition-colors duration-300 hover:text-gold-hi hover:decoration-gold/60"
    >
      {formatClock(position)}
    </button>
  );
}

/** A hold-on pause, as a note across the log rather than a bubble. */
function HoldLine({ m, them }: { m: ChatMessage; them: string }) {
  return (
    <div
      data-wire={m.wireId}
      className="flex items-center gap-3 self-stretch font-mono text-[9.5px] uppercase tracking-[0.16em] text-warn [animation:ry-in-soft_.4s_ease_both]"
    >
      <span className="h-px flex-1 bg-warn/30" />
      <span className="max-w-[75%] truncate normal-case tracking-normal">
        <span className="uppercase tracking-[0.16em]">{m.mine ? 'you' : them} · hold on</span>
        {m.text !== 'hold on' && <span className="font-serif text-[12px] italic"> — {m.text}</span>}
      </span>
      {m.position !== null && <Stamp position={m.position} />}
      <span className="h-px flex-1 bg-warn/30" />
    </div>
  );
}

function TypingDots() {
  return (
    <span aria-hidden className="flex gap-[3px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-[4px] w-[4px] rounded-full bg-gold-hi/70 [animation:ry-pulse_1.1s_ease-in-out_infinite]"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

function ReplyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 5 5v6" />
    </svg>
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
            aria-label={`Message from ${them}: ${lineLabel(c.text)}. Open chat`}
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
            {(() => {
              const sticker = parseSticker(c.text);
              return sticker ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={sticker.src}
                  alt={sticker.label}
                  draggable={false}
                  className="block h-[74px] w-auto select-none"
                />
              ) : (
                <span className="block break-words text-sm leading-[1.6]">{c.text}</span>
              );
            })()}
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
