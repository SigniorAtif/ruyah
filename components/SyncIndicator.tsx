'use client';

import { useState } from 'react';
import { useRuya } from '@/lib/store';

/**
 * §11 — small, corner-mounted, honest.
 *   green: within the deadband
 *   amber: correcting, or waiting out a differential resume
 *   red:   peer disconnected, or drift over 1s pending confirmation
 * Live drift in ms on hover.
 */
export function SyncIndicator() {
  const [open, setOpen] = useState(false);
  const status = useRuya((s) => s.status);
  if (!status) return null;

  const colour =
    status.syncHealth === 'green'
      ? 'bg-ok'
      : status.syncHealth === 'amber'
        ? 'bg-warn'
        : 'bg-bad';

  const drift = status.driftMs;
  const headline = status.waitingToResume
    ? 'Waiting out your lead'
    : status.catchingUp
      ? 'Behind — catching up gently'
      : status.correcting
        ? 'Correcting'
        : status.pendingHardDrift > 0
          ? `Drift confirmed ${status.pendingHardDrift}/3`
          : 'In sync';

  return (
    <div
      className="pointer-events-auto absolute right-4 top-4 z-20"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div className="flex items-center gap-2 rounded-full bg-black/50 px-2.5 py-1.5 backdrop-blur">
        <span className={`h-2 w-2 rounded-full ${colour}`} />
        {open && <span className="text-[11px] text-white/80">{headline}</span>}
      </div>

      {open && (
        <div className="mt-2 w-56 rounded border border-line bg-panel/95 p-3 font-mono text-[11px] text-muted backdrop-blur">
          <Line
            label="drift"
            value={drift === null ? 'no heartbeat yet' : `${drift > 0 ? '+' : ''}${Math.round(drift)} ms`}
          />
          <Line label="deadband" value={`±${Math.round(status.deadbandMs)} ms`} />
          <Line label="rtt" value={`${Math.round(status.rttMs)} ±${Math.round(status.rttStdDevMs)} ms`} />
          <Line label="rate" value={status.playbackRate.toFixed(2)} />
          <Line label="role" value={status.isAuthority ? 'authority' : 'follower'} />
          {status.manualOffsetSec !== 0 && (
            <Line label="offset" value={`${status.manualOffsetSec.toFixed(1)} s`} />
          )}
          <p className="mt-2 border-t border-line pt-2 leading-relaxed">
            {status.isAuthority
              ? 'You set the pace; she corrects toward you.'
              : 'Positive drift means you are ahead of her.'}
          </p>
        </div>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}
