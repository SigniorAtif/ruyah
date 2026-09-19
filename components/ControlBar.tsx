'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { MediaTrack } from '@/lib/player/engine';
import { formatClock } from '@/lib/player/fingerprint';
import { SUBTITLE_ACCEPT } from '@/lib/player/subtitles';
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { EMOJI_GROUPS, MAX_BURST, searchEmoji } from '@/lib/emoji';
import { getEngine, REACTIONS, useRuya } from '@/lib/store';
import { formatOffset, useDisplayOffset } from './PlayerPanels';

/** Fraction of an element's width under the pointer, clamped to 0..1. */
function fractionAt(e: ReactPointerEvent<HTMLElement>): number {
  const r = e.currentTarget.getBoundingClientRect();
  return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
}

/** The popovers and panels the bar can open; only one is open at a time. */
export type PlayerPanel = 'tracks' | 'offset' | 'dev' | 'react' | 'hold';

/**
 * §11 — every action here goes through PlayerEngine. Nothing in this file
 * touches the video element, because a local play/seek that skipped the engine
 * would never reach the other person.
 */
export function ControlBar({
  visible,
  containerRef,
  showKeysHint,
  onOpenKeys,
  panel,
  onTogglePanel,
  onClosePanel,
  showDev,
}: {
  visible: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  showKeysHint: boolean;
  onOpenKeys: () => void;
  panel: PlayerPanel | null;
  onTogglePanel: (p: PlayerPanel) => void;
  onClosePanel: () => void;
  showDev: boolean;
}) {
  const tracksOpen = panel === 'tracks';
  const offsetOpen = panel === 'offset';
  const onToggleTracks = () => onTogglePanel('tracks');
  const onToggleOffset = () => onTogglePanel('offset');
  const onToggleDev = () => onTogglePanel('dev');
  const status = useRuya((s) => s.status);
  const showToast = useRuya((s) => s.showToast);
  const chatOpen = useRuya((s) => s.chatOpen);
  const unread = useRuya((s) => s.unread);
  const setChatOpen = useRuya((s) => s.setChatOpen);
  const offset = useDisplayOffset();
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const engine = getEngine();

  if (!status) return null;
  // A drag beats a coalescing keyboard seek, which beats where we actually are:
  // the rail should show where you are asking to go until it gets there.
  const position = scrub ?? status.pendingSeekTarget ?? status.position;
  const duration = status.duration || 0;
  const pending = status.pendingSeekTarget !== null;
  const pct = duration ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;

  const toggleFullscreen = () => {
    // The wrapper, not the <video>: the control bar has to come with it.
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  const onRailDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    setScrub(fractionAt(e) * duration);
  };
  const onRailMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const f = fractionAt(e);
    setHover(f * 100);
    if (dragging.current) setScrub(f * duration);
  };
  const onRailUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (scrub !== null) {
      engine?.seek(scrub);
      showToast(`Jump to ${formatClock(scrub)}`);
    }
    setScrub(null);
  };

  const onVolume = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointermove' && e.buttons === 0) return;
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    const v = Math.round(fractionAt(e) * 100) / 100;
    // Volume is local: it never reaches the transport (rule 1).
    engine?.setVolume(v);
    if (v > 0 && status.muted) engine?.setMuted(false);
  };

  const muted = status.muted || status.volume === 0;
  const volPct = muted ? 0 : Math.round(status.volume * 100);
  const hovering = hover !== null || scrub !== null;

  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-[5] bg-[linear-gradient(to_top,rgba(11,11,10,0.88)_0%,rgba(11,11,10,0.6)_55%,transparent_100%)] px-[clamp(16px,3vw,32px)] pb-6 transition-[opacity,transform] duration-[550ms] ease-[cubic-bezier(.2,.8,.2,1)] ${
        visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-[18px] opacity-0'
      }`}
    >
      <div className="relative pt-12">
        {hover !== null && duration > 0 && (
          <div
            className="pointer-events-none absolute bottom-[30px] -translate-x-1/2 whitespace-nowrap rounded-sm border border-line-strong bg-stage/90 px-[9px] py-[5px] font-mono text-[11px] tabular-nums [animation:ry-in-soft_.2s_ease_both]"
            style={{ left: `${hover}%` }}
          >
            {formatClock((hover / 100) * duration)}
          </div>
        )}

        {pending && hover === null && (
          <div
            className="pointer-events-none absolute bottom-9 -translate-x-1/2 whitespace-nowrap font-mono text-[9.5px] uppercase tracking-[0.14em] text-warn [animation:ry-in-soft_.3s_ease_both]"
            style={{ left: `${pct}%` }}
          >
            seek pending sync
          </div>
        )}

        <div
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`${formatClock(position)} of ${formatClock(duration)}`}
          onPointerDown={onRailDown}
          onPointerMove={onRailMove}
          onPointerUp={onRailUp}
          onPointerCancel={onRailUp}
          onPointerLeave={() => setHover(null)}
          className="relative mb-3 cursor-pointer touch-none py-[9px]"
        >
          <div
            className="relative rounded-sm bg-foreground/20 transition-[height] duration-250"
            style={{ height: hovering ? 5 : 3 }}
          >
            <div
              className={`absolute inset-y-0 left-0 rounded-sm transition-colors duration-500 ${
                pending ? 'bg-warn' : 'bg-gold'
              }`}
              style={{ width: `${pct}%` }}
            />
            <div
              className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,height,background-color] duration-250 ${
                pending ? 'bg-warn' : 'bg-gold-hi'
              }`}
              style={{ left: `${pct}%`, width: hovering ? 13 : 11, height: hovering ? 13 : 11 }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-[clamp(12px,2vw,22px)]">
          <button
            type="button"
            onClick={() => engine?.togglePlay()}
            aria-label={status.playing ? 'Pause' : 'Play'}
            className="flex cursor-pointer border-0 bg-transparent p-0 transition-[color,transform] duration-200 hover:text-gold-hi active:scale-90"
          >
            {status.playing ? <PauseIcon /> : <PlayIcon />}
          </button>

          <span className="font-mono text-[13px] tabular-nums tracking-[0.04em]">
            {formatClock(position)} / {formatClock(duration)}
          </span>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => engine?.setMuted(!status.muted)}
              aria-label={muted ? 'Unmute' : 'Mute'}
              className={`flex cursor-pointer border-0 bg-transparent p-0 transition-colors duration-300 hover:text-gold-hi ${
                muted ? 'text-muted' : ''
              }`}
            >
              {muted ? <MutedIcon /> : <VolumeIcon />}
            </button>
            <div
              role="slider"
              tabIndex={-1}
              aria-label="Volume"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={volPct}
              onPointerDown={onVolume}
              onPointerMove={onVolume}
              className="w-24 cursor-pointer touch-none py-2"
            >
              <div className="relative h-[3px] rounded-sm bg-foreground/20">
                <div
                  className="absolute inset-y-0 left-0 rounded-sm bg-foreground/70 transition-[width] duration-200"
                  style={{ width: `${volPct}%` }}
                />
                <div
                  className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground transition-[left] duration-200"
                  style={{ left: `${volPct}%` }}
                />
              </div>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-[clamp(10px,1.6vw,18px)]">
            <div className="relative flex">
              <AnimatePresence>
                {panel === 'hold' && <HoldPopover key="hold" onDone={onClosePanel} />}
              </AnimatePresence>
              <button
                type="button"
                onClick={() => onTogglePanel('hold')}
                aria-label="Hold on"
                aria-expanded={panel === 'hold'}
                title="Hold on (H)"
                className={`flex cursor-pointer border-0 bg-transparent p-0 transition-[color,transform] duration-250 hover:text-gold-hi active:scale-90 ${
                  panel === 'hold' ? 'text-gold-hi' : ''
                }`}
              >
                <HoldIcon />
              </button>
            </div>
            <div className="relative flex">
              <AnimatePresence>
                {panel === 'react' && <ReactPopover key="react" onDone={onClosePanel} />}
              </AnimatePresence>
              <button
                type="button"
                onClick={() => onTogglePanel('react')}
                aria-label="React"
                aria-expanded={panel === 'react'}
                className={`flex cursor-pointer border-0 bg-transparent p-0 transition-[color,transform] duration-250 hover:text-gold-hi active:scale-90 ${
                  panel === 'react' ? 'text-gold-hi' : ''
                }`}
              >
                <ReactIcon />
              </button>
            </div>
            <div className="relative flex">
              {tracksOpen && <TracksPanel onClose={onToggleTracks} />}
              <button
                type="button"
                onClick={onToggleTracks}
                aria-label="Subtitles and audio"
                aria-expanded={tracksOpen}
                className={`flex cursor-pointer border-0 bg-transparent p-0 transition-[color,transform] duration-250 hover:text-gold-hi active:scale-90 ${
                  tracksOpen || status.activeTextTrack >= 0 ? 'text-gold-hi' : ''
                }`}
              >
                <SubtitlesIcon />
              </button>
            </div>
            {showKeysHint && (
              <button
                type="button"
                onClick={onOpenKeys}
                className="kicker cursor-pointer border-0 bg-transparent p-0 tracking-[0.18em] transition-colors duration-300 hover:text-foreground"
              >
                keys
              </button>
            )}
            <button
              type="button"
              onClick={() => setChatOpen(!chatOpen)}
              aria-label={unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
              aria-pressed={chatOpen}
              className={`flex cursor-pointer items-center gap-2 rounded border px-[11px] py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors duration-[350ms] hover:border-gold hover:text-gold-hi ${
                chatOpen ? 'border-gold bg-gold/10 text-gold-hi' : 'border-foreground/15 bg-transparent text-foreground'
              }`}
            >
              <span>chat</span>
              {unread > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[9.5px] tabular-nums text-background [animation:ry-pop_.35s_cubic-bezier(.2,.8,.2,1)_both]">
                  {unread}
                </span>
              )}
            </button>
            {showDev && (
              <button
                type="button"
                onClick={onToggleDev}
                className="cursor-pointer rounded border border-foreground/15 bg-transparent px-[11px] py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-faint transition-colors duration-300 hover:border-foreground/40 hover:text-foreground"
              >
                dev
              </button>
            )}
            <button
              type="button"
              onClick={onToggleOffset}
              aria-expanded={offsetOpen}
              className={`cursor-pointer rounded border px-[13px] py-[7px] font-mono text-[10.5px] uppercase tracking-[0.16em] transition-colors duration-[350ms] hover:border-gold hover:text-gold-hi ${
                offset === 0
                  ? 'border-line-strong bg-transparent text-foreground'
                  : 'border-gold bg-gold/15 text-gold-hi'
              }`}
            >
              {offset === 0 ? 'offset' : `offset ${formatOffset(offset)}`}
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label="Fullscreen"
              className="flex cursor-pointer border-0 bg-transparent p-0 transition-[color,transform] duration-250 hover:text-gold-hi active:scale-90"
            >
              <FullscreenIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "English", from a BCP 47 tag, where the browser can name it. */
function languageName(tag: string): string {
  if (!tag) return '';
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

function trackName(t: MediaTrack, n: number): string {
  const lang = languageName(t.language);
  if (t.label && lang && !t.label.toLowerCase().includes(lang.toLowerCase())) {
    return `${t.label} · ${lang}`;
  }
  return t.label || lang || `Track ${n + 1}`;
}

/**
 * Subtitles and audio language. Both are local: each person picks their own,
 * and neither reaches the other player (rule 1, as with volume).
 */
function TracksPanel({ onClose }: { onClose: () => void }) {
  const status = useRuya((s) => s.status);
  const showToast = useRuya((s) => s.showToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const engine = getEngine();
  if (!status) return null;

  const pickText = (index: number, name: string) => {
    engine?.setTextTrack(index);
    showToast(index < 0 ? 'Subtitles off' : `Subtitles · ${name}`);
  };
  const pickAudio = (index: number, name: string) => {
    if (index === status.activeAudioTrack) return;
    engine?.setAudioTrack(index);
    // Extracted tracks announce themselves when ready; say it has started.
    showToast(status.audioPreparing || index !== 0 ? `Switching audio · ${name}` : `Audio · ${name}`);
  };
  const onFile = async (file: File | undefined) => {
    if (!file || !engine) return;
    try {
      const label = await engine.addSubtitleFile(file);
      showToast(`Subtitles · ${label}`);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not read that file.');
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Subtitles and audio"
      className="absolute bottom-[calc(100%+18px)] right-[-8px] z-[8] w-[min(300px,calc(100vw-32px))] rounded border border-foreground/15 bg-[rgba(25,23,21,0.96)] px-5 py-4 text-left backdrop-blur-md [animation:ry-pop_.3s_cubic-bezier(.2,.8,.2,1)_both]"
    >
      <p className="kicker mb-2">subtitles</p>
      <ul className="mb-3 max-h-[30vh] overflow-y-auto">
        <TrackOption
          active={status.activeTextTrack < 0}
          label="Off"
          onClick={() => pickText(-1, '')}
        />
        {status.textTracks.map((t, n) => (
          <TrackOption
            key={t.index}
            active={status.activeTextTrack === t.index}
            label={trackName(t, n)}
            onClick={() => pickText(t.index, trackName(t, n))}
          />
        ))}
      </ul>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-kicker transition-colors duration-300 hover:text-gold-hi"
      >
        + load .srt / .vtt
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={SUBTITLE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {status.subtitlesPreparing !== null && (
        <p className="mt-2 font-mono text-[10.5px] tabular-nums text-warn">
          reading subtitles from the file · {Math.round(status.subtitlesPreparing * 100)}%
        </p>
      )}
      <p className="mt-1.5 text-[11.5px] leading-[1.5] text-faint">
        Stays on this machine. Text subtitles inside the file are read out on their own; picture
        subtitles (PGS) cannot be shown.
      </p>

      <div className="my-4 h-px bg-line-soft" />

      <p className="kicker mb-2">audio language</p>
      {status.audioTracks.length > 1 ? (
        <ul className="max-h-[24vh] overflow-y-auto">
          {status.audioTracks.map((t, n) => {
            const preparing = status.audioPreparing?.index === t.index ? status.audioPreparing : null;
            return (
              <TrackOption
                key={t.index}
                active={status.activeAudioTrack === t.index}
                label={trackName(t, n)}
                detail={preparing ? `${Math.round(preparing.progress * 100)}%` : undefined}
                onClick={() => pickAudio(t.index, trackName(t, n))}
              />
            );
          })}
        </ul>
      ) : (
        <p className="text-[11.5px] leading-[1.5] text-faint">
          {status.audioTracks.length === 1
            ? 'This file has one audio track.'
            : 'No other audio tracks found in this file.'}
        </p>
      )}
      {status.audioPreparing && (
        <p className="mt-1.5 text-[11.5px] leading-[1.5] text-faint">
          Reading that track out of the file. The film keeps playing meanwhile.
        </p>
      )}
      {status.audioError && (
        <p className="mt-1.5 text-[11.5px] leading-[1.5] text-bad">{status.audioError}</p>
      )}
    </div>
  );
}

function TrackOption({
  active,
  label,
  detail,
  onClick,
}: {
  active: boolean;
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={`flex w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-0 py-[5px] text-left text-[13.5px] transition-colors duration-200 hover:text-gold-hi ${
          active ? 'text-foreground' : 'text-muted'
        }`}
      >
        <span
          aria-hidden
          className={`h-[5px] w-[5px] flex-none rounded-full ${active ? 'bg-gold-hi' : 'bg-transparent'}`}
        />
        <span className="truncate">{label}</span>
        {detail && (
          <span className="ml-auto flex-none font-mono text-[10.5px] tabular-nums text-warn">
            {detail}
          </span>
        )}
      </button>
    </li>
  );
}

function SubtitlesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="3" y="5.5" width="18" height="13" rx="1.5" />
      <path d="M6.5 14h4" />
      <path d="M12.5 14h5" />
      <path d="M6.5 11h7" />
      <path d="M15.5 11h2" />
    </svg>
  );
}

const popIn = {
  initial: { opacity: 0, y: 10, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 6, scale: 0.98 },
  transition: { type: 'spring', stiffness: 420, damping: 30 },
} as const;

/** Emoji buttons are this square, in the row and the grid alike. */
const EMOJI_PX = 36;
/** Released before this, a press is a tap: one reaction. */
const TAP_MS = 180;
/** How long holding takes to grow from one reaction to MAX_BURST. */
const GROW_MS = 1_300;
/** How big the held emoji gets at MAX_BURST. */
const MAX_SCALE = 3;

/** 0 while it is still a tap, then 0..1 as the hold grows toward MAX_BURST. */
function holdProgress(elapsedMs: number): number {
  return Math.min(1, Math.max(0, (elapsedMs - TAP_MS) / GROW_MS));
}

function burstAt(progress: number): number {
  return 1 + Math.round(progress * (MAX_BURST - 1));
}

interface Held {
  emoji: string;
  /** Centre of the pressed button, relative to the popover's root. */
  cx: number;
  cy: number;
}

/**
 * The quick row, with an arrow that grows it into a scrollable square of
 * every reaction. A tap sends one; holding grows the emoji and the burst
 * with it, up to MAX_BURST, where it shakes to say it will not get bigger.
 * They float over both screens.
 */
function ReactPopover({ onDone }: { onDone: () => void }) {
  const sendReaction = useRuya((s) => s.sendReaction);
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const [held, setHeld] = useState<Held | null>(null);
  const [count, setCount] = useState(1);
  const [maxed, setMaxed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const startedAt = useRef(0);
  const frame = useRef<number | null>(null);
  const scale = useMotionValue(1);
  // The count rides just above the emoji's top edge as it grows.
  const badgeY = useTransform(scale, (v) => -(EMOJI_PX * v) / 2 - 14);

  const stopTicking = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  useEffect(() => stopTicking, []);

  const press = (emoji: string, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !rootRef.current) return;
    // Keeps the release ours even if the finger drifts off the button.
    e.currentTarget.setPointerCapture(e.pointerId);
    const b = e.currentTarget.getBoundingClientRect();
    const r = rootRef.current.getBoundingClientRect();
    setHeld({ emoji, cx: b.left + b.width / 2 - r.left, cy: b.top + b.height / 2 - r.top });
    setCount(1);
    setMaxed(false);
    scale.set(1);
    // Same clock as performance.now(), without calling it here.
    startedAt.current = e.timeStamp;
    stopTicking();
    const tick = () => {
      const t = holdProgress(performance.now() - startedAt.current);
      scale.set(1 + (MAX_SCALE - 1) * t);
      setCount(burstAt(t));
      if (t >= 1) {
        setMaxed(true);
        frame.current = null;
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  const release = () => {
    if (!held) return;
    stopTicking();
    sendReaction(held.emoji, burstAt(holdProgress(performance.now() - startedAt.current)));
    setHeld(null);
    onDone();
  };

  // The browser took the touch for a scroll: no reaction.
  const cancel = () => {
    stopTicking();
    setHeld(null);
  };

  const emojiButton = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      role="menuitem"
      aria-label={emoji}
      onPointerDown={(e) => press(emoji, e)}
      onPointerUp={release}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      // Pointer presses are handled above; this is Enter or Space.
      onClick={(e) => {
        if (e.detail !== 0) return;
        sendReaction(emoji);
        onDone();
      }}
      style={{ width: EMOJI_PX, height: EMOJI_PX }}
      className={`flex cursor-pointer select-none items-center justify-center rounded-full border-0 bg-transparent text-[20px] transition-[background-color,transform,opacity] duration-200 [-webkit-touch-callout:none] hover:scale-125 hover:bg-foreground/10 ${
        held?.emoji === emoji ? 'opacity-0' : ''
      }`}
    >
      {emoji}
    </button>
  );

  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.2, delay: 0.08 } },
    exit: { opacity: 0, transition: { duration: 0.1 } },
  } as const;

  return (
    <motion.div
      {...popIn}
      ref={rootRef}
      className="absolute bottom-[calc(100%+16px)] left-1/2 z-[8]"
      style={{ x: '-50%' }}
    >
      <motion.div
        layout
        role="menu"
        aria-label="Reactions"
        initial={false}
        animate={{ borderRadius: expanded ? 14 : 24 }}
        transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        className="overflow-hidden border border-foreground/15 bg-[rgba(25,23,21,0.96)] backdrop-blur-md"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {expanded ? (
            <motion.div key="all" layout {...fade} className="p-2">
              <EmojiBrowser renderEmoji={emojiButton} onCollapse={() => setExpanded(false)} />
            </motion.div>
          ) : (
            <motion.div key="quick" layout {...fade} className="flex items-center gap-1 px-2 py-1.5">
              {REACTIONS.map(emojiButton)}
              <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-label="More reactions"
                aria-expanded={false}
                className="ml-0.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted transition-colors duration-200 hover:bg-foreground/10 hover:text-gold-hi"
              >
                <ChevronIcon />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* The held emoji, lifted out of the clipped grid so it can outgrow it. */}
      {held && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10"
          style={{ left: held.cx, top: held.cy }}
        >
          <motion.span
            className="absolute flex select-none items-center justify-center text-[20px] drop-shadow-[0_6px_18px_rgba(0,0,0,0.55)]"
            style={{ width: EMOJI_PX, height: EMOJI_PX, left: -EMOJI_PX / 2, top: -EMOJI_PX / 2, scale }}
            animate={
              maxed && !reduceMotion
                ? { rotate: [0, -10, 9, -7, 6, 0], x: [0, -2.5, 2.5, -2, 2, 0] }
                : { rotate: 0, x: 0 }
            }
            transition={maxed ? { duration: 0.42, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.15 }}
          >
            {held.emoji}
          </motion.span>
          {count > 1 && (
            <motion.span
              className={`absolute -translate-x-1/2 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10.5px] tabular-nums backdrop-blur-md ${
                maxed ? 'border-gold bg-gold/20 text-gold-hi' : 'border-foreground/15 bg-stage/80 text-foreground'
              }`}
              style={{ y: badgeY, top: -10 }}
            >
              ×{count}
              {maxed && ' max'}
            </motion.span>
          )}
        </div>
      )}
    </motion.div>
  );
}

/**
 * Every reaction, in sections with tabs that jump between them, and a search
 * that narrows them to the ones whose words match.
 */
function EmojiBrowser({
  renderEmoji,
  onCollapse,
}: {
  renderEmoji: (emoji: string) => ReactNode;
  onCollapse: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(EMOJI_GROUPS[0].id);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const results = query.trim() ? searchEmoji(query) : null;

  useEffect(() => {
    // Straight to typing with a mouse; on touch that would throw up the keyboard.
    if (!window.matchMedia('(pointer: coarse)').matches) search.current?.focus();
  }, []);

  const jump = (id: string) => {
    const el = sections.current.get(id);
    const box = scroller.current;
    if (!el || !box) return;
    box.scrollTo({ top: el.offsetTop - box.offsetTop, behavior: 'smooth' });
  };

  // The tab under the top edge of the grid is the one lit.
  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    let current = EMOJI_GROUPS[0].id;
    for (const g of EMOJI_GROUPS) {
      const el = sections.current.get(g.id);
      if (el && el.offsetTop - box.offsetTop <= box.scrollTop + 8) current = g.id;
    }
    setActive(current);
  };

  const grid = { gridTemplateColumns: `repeat(7, ${EMOJI_PX}px)` };

  return (
    <>
      <div className="flex items-center gap-2 pb-1.5 pl-2">
        <input
          ref={search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // First Escape clears the search; the next one leaves the field.
            e.stopPropagation();
            if (query) setQuery('');
            else e.currentTarget.blur();
          }}
          placeholder="search"
          aria-label="Search reactions"
          spellCheck={false}
          className="min-w-0 flex-1 border-0 border-b border-line bg-transparent px-0.5 py-1 font-mono text-[11px] text-foreground caret-gold-hi outline-none transition-colors duration-300 placeholder:uppercase placeholder:tracking-[0.16em] focus:border-gold"
        />
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Fewer reactions"
          aria-expanded
          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted transition-colors duration-200 hover:bg-foreground/10 hover:text-gold-hi"
        >
          <ChevronIcon down />
        </button>
      </div>
      {!results && (
        <div role="tablist" aria-label="Reaction groups" className="flex gap-1 pb-1.5 pl-1">
          {EMOJI_GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={active === g.id}
              onClick={() => jump(g.id)}
              className={`cursor-pointer rounded-full border-0 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] transition-colors duration-200 ${
                active === g.id ? 'bg-gold/15 text-gold-hi' : 'bg-transparent text-faint hover:text-foreground'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="relative h-[228px] overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,black_86%,transparent)] [scrollbar-width:none]"
      >
        {results ? (
          results.length ? (
            <div className="grid" style={grid}>
              {results.map(renderEmoji)}
            </div>
          ) : (
            <p className="px-2 pt-6 text-center font-display text-[15px] italic text-muted">
              Nothing by that name.
            </p>
          )
        ) : (
          EMOJI_GROUPS.map((g, i) => (
            <section
              key={g.id}
              ref={(el) => {
                if (el) sections.current.set(g.id, el);
                else sections.current.delete(g.id);
              }}
              aria-label={g.label}
            >
              <p
                className={`px-2 pb-1 font-mono text-[9px] uppercase tracking-[0.18em] text-faint ${i ? 'pt-2' : ''}`}
              >
                {g.label}
              </p>
              <div className="grid" style={grid}>
                {g.emoji.map(([e]) => renderEmoji(e))}
              </div>
            </section>
          ))
        )}
      </div>
    </>
  );
}

function ChevronIcon({ down = false }: { down?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ transform: down ? 'rotate(180deg)' : undefined }}
    >
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

const HOLD_REASONS = ['one sec', 'getting snacks', 'bathroom break', 'phone call'];

/**
 * Pause for both of you, with a reason they will see. An ordinary pause
 * underneath, so it syncs like any other; the reason rides along in chat.
 */
function HoldPopover({ onDone }: { onDone: () => void }) {
  const holdOn = useRuya((s) => s.holdOn);
  const [custom, setCustom] = useState('');
  const hold = (reason: string) => {
    holdOn(reason);
    onDone();
  };
  return (
    <motion.div
      {...popIn}
      role="dialog"
      aria-label="Hold on"
      className="absolute bottom-[calc(100%+18px)] right-[-8px] z-[8] w-[min(250px,calc(100vw-32px))] rounded border border-foreground/15 bg-[rgba(25,23,21,0.96)] px-4 py-3.5 text-left backdrop-blur-md"
    >
      <p className="kicker mb-2">hold on</p>
      <ul className="mb-3">
        {HOLD_REASONS.map((r) => (
          <li key={r}>
            <button
              type="button"
              onClick={() => hold(r)}
              className="w-full cursor-pointer border-0 bg-transparent px-0 py-[5px] text-left font-serif text-[13.5px] text-muted transition-colors duration-200 hover:text-gold-hi"
            >
              {r}
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          hold(custom || 'hold on');
        }}
      >
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="or say why"
          maxLength={60}
          aria-label="Reason"
          className="w-full border-0 border-b border-line-strong bg-transparent px-0.5 py-[7px] font-serif text-[13px] text-foreground caret-gold-hi outline-none transition-colors duration-500 focus:border-gold-hi"
        />
      </form>
    </motion.div>
  );
}

function ReactIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2" />
      <path d="M9.2 9.6h.01M14.8 9.6h.01" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function HoldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M11 10.5V5a1.5 1.5 0 0 1 3 0v5.5" />
      <path d="M14 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.9-2.6L4 14.5a1.5 1.5 0 0 1 2.4-1.8L8 14.5V12" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5l11 7-11 7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="7" y="5" width="3.4" height="14" />
      <rect x="14" y="5" width="3.4" height="14" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M4 9h3l4-4v14l-4-4H4z" />
      <path d="M16 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M18.5 7a7 7 0 0 1 0 10" />
    </svg>
  );
}

function MutedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M4 9h3l4-4v14l-4-4H4z" />
      <path d="M16.5 9.5l5 5" />
      <path d="M21.5 9.5l-5 5" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </svg>
  );
}
