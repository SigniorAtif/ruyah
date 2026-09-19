'use client';

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { formatClock } from '@/lib/player/fingerprint';
import { getEngine, useRuya } from '@/lib/store';

const OFFSET_RANGE_S = 30;
const OFFSET_MIN_S = -OFFSET_RANGE_S;
const OFFSET_STEP_S = 0.1;

/**
 * The offset as the person reads it: positive means *I* am further into the
 * film at the same moment (my copy has the longer intro). The engine's
 * manualOffsetSec is added to drift (spec §7), so it carries the opposite sign.
 */
export function useDisplayOffset(): number {
  const engineOffset = useRuya((s) => s.status?.manualOffsetSec ?? 0);
  return engineOffset === 0 ? 0 : -engineOffset;
}

function setDisplayOffset(seconds: number): void {
  const clamped = Math.max(-OFFSET_RANGE_S, Math.min(OFFSET_RANGE_S, seconds));
  const rounded = Math.round(clamped / OFFSET_STEP_S) * OFFSET_STEP_S;
  getEngine()?.setManualOffset(rounded === 0 ? 0 : -Number(rounded.toFixed(1)));
}

/** Relative to the engine's live value, so two quick presses both count. */
function nudgeDisplayOffset(delta: number): void {
  const current = -(getEngine()?.getStatus().manualOffsetSec ?? 0);
  setDisplayOffset(current + delta);
}

export function formatOffset(seconds: number): string {
  return `${seconds >= 0 ? '+' : '−'}${Math.abs(seconds).toFixed(1)}s`;
}

const panelClass =
  'absolute bottom-[136px] z-[9] rounded border border-foreground/15 bg-[rgba(20,19,18,0.94)] backdrop-blur-lg [animation:ry-pop_.4s_cubic-bezier(.2,.8,.2,1)_both]';

/**
 * §11 — manual offset, for copies cut differently. A constant in the drift
 * math rather than a seek, so neither side jumps; the follower's player eases
 * across to it.
 */
export function OffsetPanel() {
  const offset = useDisplayOffset();
  const isAuthority = useRuya((s) => s.status?.isAuthority ?? false);
  const dragging = useRef(false);

  const pct = ((offset + OFFSET_RANGE_S) / (OFFSET_RANGE_S * 2)) * 100;
  const fillLeft = offset >= 0 ? 50 : pct;
  const fillWidth = (Math.abs(offset) / (OFFSET_RANGE_S * 2)) * 100;

  const fromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5;
    setDisplayOffset(f * OFFSET_RANGE_S * 2 - OFFSET_RANGE_S);
  };

  return (
    <div
      role="dialog"
      aria-label="Manual offset"
      className={`${panelClass} right-8 w-[min(360px,calc(100%-64px))] px-6 py-[22px]`}
    >
      <h4 className="mb-2.5 font-display text-xl font-semibold">Manual offset</h4>
      <p className="mb-5 text-[12.5px] leading-[1.7] text-muted">
        If the other copy has an extra intro, shift the comparison instead of seeking. Positive
        means you are further into the film at the same moment.
      </p>
      <div className="mb-2.5 flex items-baseline justify-between font-mono text-[10px] text-faint">
        <span>−{OFFSET_RANGE_S}s</span>
        <span className="text-xl tabular-nums text-gold-hi">{formatOffset(offset)}</span>
        <span>+{OFFSET_RANGE_S}s</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Offset in seconds"
        aria-valuemin={OFFSET_MIN_S}
        aria-valuemax={OFFSET_RANGE_S}
        aria-valuenow={Number(offset.toFixed(1))}
        aria-valuetext={formatOffset(offset)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) fromPointer(e);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            nudgeDisplayOffset(-OFFSET_STEP_S);
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            nudgeDisplayOffset(OFFSET_STEP_S);
          }
        }}
        className="relative mb-5 cursor-pointer touch-none py-[9px]"
      >
        <div className="relative h-[3px] rounded-sm bg-foreground/20">
          <div className="absolute -inset-y-1 left-1/2 w-px bg-foreground/30" />
          <div
            className="absolute inset-y-0 bg-gold transition-[left,width] duration-200"
            style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
          />
          <div
            className="absolute top-1/2 h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold-hi transition-[left] duration-200"
            style={{ left: `${pct}%` }}
          />
        </div>
      </div>
      {isAuthority && (
        <p className="-mt-2 mb-4 text-[11.5px] leading-[1.55] text-faint">
          You set the pace, so the other player does the correcting. An offset here changes what
          the sync readout measures; set it on their side to move playback.
        </p>
      )}
      <div className="flex items-center justify-between border-t border-line-soft pt-3.5">
        <div className="flex gap-2">
          <StepButton label="−" aria="Decrease offset" onClick={() => nudgeDisplayOffset(-OFFSET_STEP_S)} />
          <StepButton label="+" aria="Increase offset" onClick={() => nudgeDisplayOffset(OFFSET_STEP_S)} />
          <span className="ml-1 self-center font-mono text-[10.5px] text-faint">0.1s steps</span>
        </div>
        <button
          type="button"
          onClick={() => setDisplayOffset(0)}
          className="cursor-pointer border-0 border-b border-gold/50 bg-transparent p-0 font-mono text-[11px] text-gold-hi transition-colors duration-300 hover:text-foreground"
        >
          Reset to zero
        </button>
      </div>
    </div>
  );
}

function StepButton({ label, aria, onClick }: { label: string; aria: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={aria}
      className="h-[26px] w-[30px] cursor-pointer rounded-[3px] border border-foreground/20 bg-transparent font-mono text-[13px] text-muted transition-colors duration-300 hover:border-gold hover:text-gold-hi"
    >
      {label}
    </button>
  );
}

/** Dev mode only (`?dev=1`): the engine's own numbers, unrounded. */
export function DevPanel() {
  const status = useRuya((s) => s.status);
  const transportState = useRuya((s) => s.transportState);
  if (!status) return null;

  const drift = status.driftMs;
  const rows: Array<[string, string]> = [
    ['drift', drift === null ? '—' : `${drift >= 0 ? '+' : ''}${(drift / 1000).toFixed(3)} s`],
    ['deadband', `±${(status.deadbandMs / 1000).toFixed(3)} s`],
    ['rtt', `${Math.round(status.rttMs)} ±${Math.round(status.rttStdDevMs)} ms`],
    ['loss', `${Math.round(status.lossRate * 100)}%`],
    ['rate', `${status.playbackRate.toFixed(2)}×`],
    ['hard drift', `${status.pendingHardDrift}/3`],
    ['peer at', status.peerPosition === null ? '—' : formatClock(status.peerPosition)],
    ['role', status.isAuthority ? 'authority' : 'follower'],
    ['relay', transportState],
    ['link', status.connection],
  ];

  return (
    <div
      role="dialog"
      aria-label="Instruments"
      className={`${panelClass} left-[26px] w-[min(300px,calc(100%-52px))] px-5 py-[18px]`}
    >
      <p className="mb-3.5 font-mono text-[9.5px] uppercase tracking-[0.2em] text-faint">instruments</p>
      <dl className="flex flex-col gap-[7px] font-mono text-[10.5px] tabular-nums text-muted">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-faint">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
