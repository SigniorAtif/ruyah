'use client';

import { useState } from 'react';
import { useRuya } from '@/lib/store';

/**
 * §11 — small, corner-mounted, honest.
 *   green: within the deadband
 *   amber: correcting, or waiting out a differential resume
 *   red:   peer disconnected, or drift over 1s pending confirmation
 * Live drift on hover.
 */
export function SyncIndicator() {
  const [open, setOpen] = useState(false);
  const status = useRuya((s) => s.status);
  if (!status) return null;

  const tone =
    status.syncHealth === 'green'
      ? { text: 'text-ok', dot: 'bg-ok', border: 'border-ok/40', pulse: '' }
      : status.syncHealth === 'amber'
        ? {
            text: 'text-warn',
            dot: 'bg-warn',
            border: 'border-warn/45',
            pulse: '[animation:ry-pulse_1.4s_ease-in-out_infinite]',
          }
        : {
            text: 'text-bad',
            dot: 'bg-bad',
            border: 'border-bad/50',
            pulse: '[animation:ry-pulse_1s_ease-in-out_infinite]',
          };

  const label =
    status.connection !== 'ok'
      ? 'no signal'
      : status.waitingToResume
        ? 'waiting out your lead'
        : status.catchingUp
          ? 'catching up'
          : status.correcting
            ? 'correcting'
            : status.pendingHardDrift > 0
              ? `drift confirmed ${status.pendingHardDrift}/3`
              : 'in sync';

  const drift = status.driftMs;
  const rows: Array<[string, string]> = [
    ['drift', drift === null ? 'no heartbeat yet' : `${drift > 0 ? '+' : ''}${(drift / 1000).toFixed(2)} s`],
    ['deadband', `±${(status.deadbandMs / 1000).toFixed(2)} s`],
    ['rtt', `${Math.round(status.rttMs)} ±${Math.round(status.rttStdDevMs)} ms`],
    ['rate', `${status.playbackRate.toFixed(2)}×`],
    ['role', status.isAuthority ? 'authority' : 'follower'],
  ];

  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
      aria-label={`Sync: ${label}`}
      className={`absolute right-[clamp(16px,2vw,24px)] top-[22px] z-[6] cursor-default border bg-stage/60 px-3.5 py-[7px] backdrop-blur-md transition-[border-color,border-radius] duration-500 ${tone.border} ${
        open ? 'rounded-md' : 'rounded-full'
      }`}
    >
      <div className="flex items-center gap-[9px]">
        <span className={`h-1.5 w-1.5 flex-none rounded-full transition-colors duration-500 ${tone.dot} ${tone.pulse}`} />
        <span className={`font-mono text-[11px] tracking-[0.08em] transition-colors duration-500 ${tone.text}`}>
          {label}
        </span>
      </div>

      {open && (
        <div className="mt-[11px] flex min-w-[184px] flex-col gap-1.5 border-t border-line pt-[11px] font-mono text-[10.5px] tabular-nums text-muted [animation:ry-in_.3s_cubic-bezier(.2,.8,.2,1)_both]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-[18px]">
              <span className="text-faint">{k}</span>
              <span>{v}</span>
            </div>
          ))}
          <p className="mt-1 max-w-[210px] border-t border-line-soft pt-2 font-serif text-[11.5px] leading-[1.55] text-faint">
            {status.isAuthority
              ? 'You set the pace; the other player corrects toward you.'
              : 'Positive drift means you are ahead of the host.'}
          </p>
        </div>
      )}
    </div>
  );
}
