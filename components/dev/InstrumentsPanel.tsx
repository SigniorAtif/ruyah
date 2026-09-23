'use client';

import { formatClock } from '@/lib/player/fingerprint';
import { useRuya } from '@/lib/store';
import { panelClass } from '../PlayerPanels';

/** Dev mode only (`?dev=1`): the engine's own numbers, unrounded. */
export function InstrumentsPanel() {
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
