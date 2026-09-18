'use client';

import { getEngine, useRuya } from '@/lib/store';

/**
 * Sits at z-50, above every overlay including §8's.
 *
 * It has to. The cable toggle can put the transport into `disconnected`, which
 * raises the full-screen overlay, and the only control that brings it back is
 * this panel — at a lower z-index that was a one-way door: drop the connection
 * and the button to restore it was buried under the overlay it had just raised.
 *
 * §10 — a zero-latency mock hides every bug this design exists to prevent, so
 * the bad network is a first-class control here: latency, jitter, loss, and a
 * cable to pull. The drift injectors drive acceptance items 4 and 5; they move
 * this client's decoder only and broadcast nothing, which is exactly what real
 * drift looks like.
 */
export function DevPanel({ onClose }: { onClose: () => void }) {
  const network = useRuya((s) => s.network);
  const setNetwork = useRuya((s) => s.setNetwork);
  const status = useRuya((s) => s.status);
  const transportState = useRuya((s) => s.transportState);
  const peerPresent = useRuya((s) => s.peerPresent);

  if (!network) return null;

  const drift = status?.driftMs;
  const rows: Array<[string, string]> = [
    ['transport', transportState],
    ['peer', peerPresent ? 'present' : 'absent'],
    ['drift', drift === null || drift === undefined ? '—' : `${drift > 0 ? '+' : ''}${Math.round(drift)} ms`],
    ['deadband', `±${Math.round(status?.deadbandMs ?? 0)} ms`],
    ['rtt', `${Math.round(status?.rttMs ?? 0)} ±${Math.round(status?.rttStdDevMs ?? 0)} ms`],
    ['measured loss', `${Math.round((status?.lossRate ?? 0) * 100)} %`],
    ['rate', `${(status?.playbackRate ?? 1).toFixed(2)}×`],
    ['confirmations', `${status?.pendingHardDrift ?? 0}/3`],
    ['role', status?.isAuthority ? 'authority' : 'follower'],
  ];

  return (
    <div className="absolute bottom-[136px] left-[clamp(16px,2vw,26px)] z-50 max-h-[calc(100%-180px)] w-[min(300px,calc(100%-32px))] overflow-y-auto rounded border border-foreground/15 bg-[rgba(20,19,18,0.94)] px-5 py-[18px] font-mono text-[10.5px] backdrop-blur-md [animation:ry-pop_.4s_cubic-bezier(.2,.8,.2,1)_both]">
      <div className="mb-3.5 flex items-center justify-between">
        <span className="kicker text-[9.5px] tracking-[0.2em]">instruments</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close instruments"
          className="cursor-pointer border-0 bg-transparent p-0 text-faint transition-colors duration-300 hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <dl className="mb-3.5 flex flex-col gap-[7px] border-b border-line-soft pb-3.5 tabular-nums text-muted">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-faint">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      <Slider
        label="latency"
        suffix="ms round-trip"
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

      <div className="mt-3.5 flex flex-col gap-2 border-t border-line-soft pt-3.5">
        <p className="kicker">inject drift</p>
        <div className="grid grid-cols-4 gap-1.5">
          {[-2.5, -0.4, 0.4, 2.5].map((d) => (
            <ActionButton key={d} onClick={() => getEngine()?.debugInjectDrift(d)} center>
              {d > 0 ? `+${d}` : d}s
            </ActionButton>
          ))}
        </div>
        <ActionButton
          onClick={() => setNetwork({ connected: !network.connected })}
          danger={network.connected}
        >
          {network.connected ? 'drop the connection' : 'restore the connection'}
        </ActionButton>
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  center,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  center?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-[3px] border bg-transparent px-[11px] py-2 text-[10px] uppercase tracking-[0.14em] transition-colors duration-300 hover:border-gold hover:text-gold-hi ${
        center ? 'text-center' : 'text-left'
      } ${danger ? 'border-bad/40 text-bad' : 'border-foreground/20 text-muted'}`}
    >
      {children}
    </button>
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
      <div className="flex justify-between text-faint">
        <span>{label}</span>
        <span className="tabular-nums text-muted">
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
        className="mt-1 w-full cursor-pointer accent-gold"
        aria-label={label}
      />
    </div>
  );
}
