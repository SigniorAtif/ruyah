'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { formatClock } from '@/lib/player/fingerprint';
import { getEngine, useRuya } from '@/lib/store';

/** Fraction of an element's width under the pointer, clamped to 0..1. */
function fractionAt(e: ReactPointerEvent<HTMLElement>): number {
  const r = e.currentTarget.getBoundingClientRect();
  return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
}

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
}: {
  visible: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  showKeysHint: boolean;
  onOpenKeys: () => void;
}) {
  const status = useRuya((s) => s.status);
  const showToast = useRuya((s) => s.showToast);
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
