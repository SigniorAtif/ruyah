'use client';

import { useState } from 'react';
import { getEngine, useRuya } from '@/lib/store';

/**
 * §10 — a zero-latency mock hides every bug this design exists to prevent, so
 * the bad network is a first-class control here: latency, jitter, loss, and a
 * cable to pull. The drift injectors drive acceptance items 4 and 5; they move
 * this client's decoder only and broadcast nothing, which is exactly what real
 * drift looks like.
 */
export function DevPanel() {
  const [open, setOpen] = useState(false);
  const network = useRuya((s) => s.network);
  const setNetwork = useRuya((s) => s.setNetwork);
  const status = useRuya((s) => s.status);
  const transportState = useRuya((s) => s.transportState);
  const peerPresent = useRuya((s) => s.peerPresent);

  if (!network) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="pointer-events-auto absolute bottom-24 left-4 z-20 rounded bg-black/50 px-2 py-1 font-mono text-[10px] text-muted backdrop-blur hover:text-foreground"
      >
        dev
      </button>
    );
  }

  return (
    <div className="pointer-events-auto absolute bottom-24 left-4 z-30 w-72 rounded border border-line bg-panel/95 p-3 font-mono text-[11px] backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="text-muted">network simulation</span>
        <button type="button" onClick={() => setOpen(false)} className="text-muted hover:text-foreground">
          ✕
        </button>
      </div>

      <Slider
        label="latency"
        suffix="ms one-way"
        min={0}
        max={1000}
        step={10}
        value={network.latencyMs}
        onChange={(latencyMs) => setNetwork({ latencyMs })}
      />
      <Slider
        label="jitter"
        suffix="ms ±"
        min={0}
        max={500}
        step={10}
        value={network.jitterMs}
        onChange={(jitterMs) => setNetwork({ jitterMs })}
      />
      <Slider
        label="loss"
        suffix="%"
        min={0}
        max={100}
        step={5}
        value={Math.round(network.dropRate * 100)}
        onChange={(pct) => setNetwork({ dropRate: pct / 100 })}
      />

      <button
        type="button"
        onClick={() => setNetwork({ connected: !network.connected })}
        className={`mt-3 w-full rounded px-2 py-1.5 ${
          network.connected ? 'border border-bad/40 text-bad' : 'bg-bad text-background'
        }`}
      >
        {network.connected ? 'drop connection' : 'restore connection'}
      </button>

      <div className="mt-3 border-t border-line pt-2 text-muted">
        <span>inject drift</span>
        <div className="mt-1.5 grid grid-cols-4 gap-1">
          {[-2.5, -0.4, 0.4, 2.5].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => getEngine()?.debugInjectDrift(d)}
              className="rounded border border-line py-1 hover:border-muted hover:text-foreground"
            >
              {d > 0 ? `+${d}` : d}s
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-3 space-y-1 border-t border-line pt-2 text-muted">
        <Readout label="transport" value={transportState} />
        <Readout label="peer" value={peerPresent ? 'present' : 'absent'} />
        <Readout
          label="drift"
          value={
            status?.driftMs === null || status?.driftMs === undefined
              ? '—'
              : `${status.driftMs > 0 ? '+' : ''}${Math.round(status.driftMs)} ms`
          }
        />
        <Readout label="deadband" value={`±${Math.round(status?.deadbandMs ?? 0)} ms`} />
        <Readout
          label="rtt"
          value={`${Math.round(status?.rttMs ?? 0)} ±${Math.round(status?.rttStdDevMs ?? 0)} ms`}
        />
        <Readout label="rate" value={(status?.playbackRate ?? 1).toFixed(2)} />
        <Readout label="confirmations" value={`${status?.pendingHardDrift ?? 0}/3`} />
        <Readout label="role" value={status?.isAuthority ? 'authority' : 'follower'} />
      </dl>
    </div>
  );
}

function Slider({
  label,
  suffix,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mt-2.5">
      <div className="flex justify-between text-muted">
        <span>{label}</span>
        <span className="text-foreground">
          {value} {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full"
        aria-label={label}
      />
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
