'use client';

import { useMemo, useState } from 'react';
import { formatClock } from '@/lib/player/fingerprint';
import { binMoments } from '@/lib/moments';
import { getEngine, useRuya } from '@/lib/store';

/** Stretches the film is split into; about one per pixel-ish gap on a laptop. */
const BINS = 96;
/** A jump lands this far ahead of the moment, so it can be seen coming. */
const LEAD_S = 3;

/**
 * Marks above the seek rail where either of you reacted or said something,
 * taller where more happened. Hovering one says what; clicking one takes both
 * players back to just before it, as an ordinary seek.
 */
export function MomentMarks({ duration }: { duration: number }) {
  const moments = useRuya((s) => s.moments);
  const messages = useRuya((s) => s.messages);
  const showToast = useRuya((s) => s.showToast);
  const [hovered, setHovered] = useState<number | null>(null);

  const bins = useMemo(
    () =>
      binMoments(
        moments,
        messages.filter((m) => m.position !== null && !m.hold).map((m) => m.position as number),
        duration,
        BINS,
      ),
    [moments, messages, duration],
  );
  if (!bins.length) return null;

  const shown = bins.find((b) => b.index === hovered) ?? null;

  return (
    <div className="absolute inset-x-0 top-[26px] h-[22px]" onPointerLeave={() => setHovered(null)}>
      {bins.map((b) => {
        const weight = b.copies + b.lines * 2;
        const height = Math.min(16, 3 + 3 * Math.log2(weight));
        const label = [
          formatClock(b.first),
          ...b.emoji.slice(0, 3).map(([e, n]) => (n > 1 ? `${e} ${n}` : e)),
          b.lines ? `${b.lines} ${b.lines === 1 ? 'line' : 'lines'}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <button
            key={b.index}
            type="button"
            aria-label={`Back to ${label}`}
            onPointerEnter={() => setHovered(b.index)}
            onFocus={() => setHovered(b.index)}
            onBlur={() => setHovered(null)}
            onClick={() => {
              const to = Math.max(0, b.first - LEAD_S);
              getEngine()?.seek(to);
              showToast(`Back to ${formatClock(to)}`);
            }}
            className="group absolute bottom-0 flex h-full -translate-x-1/2 cursor-pointer items-end justify-center border-0 bg-transparent p-0"
            style={{ left: `${((b.index + 0.5) / BINS) * 100}%`, width: `${100 / BINS}%`, minWidth: 6 }}
          >
            <span
              className={`w-[3px] rounded-full transition-[background-color,transform] duration-200 group-hover:scale-x-150 ${
                b.copies ? 'bg-gold-hi/85 group-hover:bg-gold-hi' : 'bg-foreground/45 group-hover:bg-foreground'
              }`}
              style={{ height }}
            />
          </button>
        );
      })}
      {shown && (
        <div
          className="pointer-events-none absolute bottom-[26px] -translate-x-1/2 whitespace-nowrap rounded-sm border border-line-strong bg-stage/90 px-[9px] py-[5px] font-mono text-[11px] tabular-nums [animation:ry-in-soft_.2s_ease_both]"
          style={{ left: `${((shown.index + 0.5) / BINS) * 100}%` }}
        >
          {formatClock(shown.first)}
          {shown.emoji.slice(0, 4).map(([e, n]) => (
            <span key={e} className="ml-2">
              {e}
              {n > 1 && <span className="ml-0.5 text-muted">{n}</span>}
            </span>
          ))}
          {shown.lines > 0 && (
            <span className="ml-2 text-muted">
              {shown.lines} {shown.lines === 1 ? 'line' : 'lines'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
