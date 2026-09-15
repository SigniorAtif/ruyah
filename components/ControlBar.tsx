'use client';

import { useRef, useState, type RefObject } from 'react';
import { formatClock } from '@/lib/player/fingerprint';
import { getEngine, useRuya } from '@/lib/store';

/**
 * §11 — every action here goes through PlayerEngine. Nothing in this file
 * touches the video element, because a local play/seek that skipped the engine
 * would never reach the other person.
 */
export function ControlBar({
  visible,
  containerRef,
}: {
  visible: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const status = useRuya((s) => s.status);
  const [scrub, setScrub] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const engine = getEngine();

  if (!status) return null;
  // A drag beats a coalescing keyboard seek, which beats where we actually are:
  // the rail should show where you are asking to go until it gets there.
  const position = scrub ?? status.pendingSeekTarget ?? status.position;
  const duration = status.duration || 0;
  const pending = status.pendingSeekTarget !== null;

  const commitScrub = () => {
    if (scrub !== null) engine?.seek(scrub);
    setScrub(null);
  };

  const toggleFullscreen = () => {
    // The wrapper, not the <video>: the control bar has to come with it.
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-20 transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      {settingsOpen && <SettingsPopover />}

      <div className="bg-gradient-to-t from-black/90 to-transparent px-4 pb-4 pt-10">
        <div
          ref={railRef}
          className="relative"
          onMouseMove={(e) => {
            const rail = railRef.current;
            if (!rail || !duration) return;
            const rect = rail.getBoundingClientRect();
            const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            setHover({ x: fraction * rect.width, time: fraction * duration });
          }}
          onMouseLeave={() => setHover(null)}
        >
          {hover && (
            <div
              className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white/90"
              style={{ left: hover.x }}
            >
              {formatClock(hover.time)}
            </div>
          )}
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={Math.min(position, duration || 1)}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            className="w-full"
            style={
              {
                '--track': `linear-gradient(to right, ${
                  pending ? 'var(--warn)' : 'var(--foreground)'
                } ${duration ? (position / duration) * 100 : 0}%, #2a2a33 0%)`,
              } as React.CSSProperties
            }
            aria-label="Seek"
          />
        </div>

        <div className="mt-2 flex items-center gap-4">
          <button
            type="button"
            onClick={() => engine?.togglePlay()}
            className="text-sm tabular-nums"
            aria-label={status.playing ? 'Pause' : 'Play'}
          >
            {status.playing ? <PauseIcon /> : <PlayIcon />}
          </button>

          <span className="font-mono text-[11px] text-muted tabular-nums">
            {formatClock(position)} / {formatClock(duration)}
          </span>

          <div className="ml-auto flex items-center gap-3">
            <VolumeControl />
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className="text-[11px] text-muted hover:text-foreground"
            >
              offset
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              className="text-[11px] text-muted hover:text-foreground"
              aria-label="Fullscreen"
            >
              ⛶
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function VolumeControl() {
  const status = useRuya((s) => s.status);
  const engine = getEngine();
  if (!status) return null;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => engine?.setMuted(!status.muted)}
        className="text-[11px] text-muted hover:text-foreground"
        aria-label={status.muted ? 'Unmute' : 'Mute'}
      >
        {status.muted || status.volume === 0 ? '🔇' : '🔊'}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={status.muted ? 0 : status.volume}
        onChange={(e) => engine?.setVolume(Number(e.target.value))}
        className="w-20"
        aria-label="Volume"
      />
    </div>
  );
}

/**
 * §11 — the manual offset is applied as a constant inside the drift maths, not
 * as a seek. It is what rescues two encodes that differ by a fixed intro.
 */
function SettingsPopover() {
  const status = useRuya((s) => s.status);
  const engine = getEngine();
  const offset = status?.manualOffsetSec ?? 0;

  return (
    <div className="absolute bottom-24 right-4 w-72 rounded border border-line bg-panel/95 p-4 backdrop-blur">
      <p className="text-xs">Manual offset</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        If her copy has an extra intro, shift the comparison instead of seeking.
        Positive means you are further into the film than she is at the same
        moment.
      </p>
      <input
        type="range"
        min={-30}
        max={30}
        step={0.1}
        value={offset}
        onChange={(e) => engine?.setManualOffset(Number(e.target.value))}
        className="mt-3 w-full"
        aria-label="Manual offset in seconds"
      />
      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted">
        <span>−30s</span>
        <span className="text-foreground">
          {offset > 0 ? '+' : ''}
          {offset.toFixed(1)}s
        </span>
        <span>+30s</span>
      </div>
      <button
        type="button"
        onClick={() => engine?.setManualOffset(0)}
        className="mt-2 text-[11px] text-muted underline-offset-2 hover:underline"
      >
        Reset to zero
      </button>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
    </svg>
  );
}
