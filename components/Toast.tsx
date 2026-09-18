'use client';

import { useRuya } from '@/lib/store';

/**
 * Rule 7 — the control bar is hidden most of the time, so a keyboard action
 * needs to say what it did. Centred low, out of the frame's way, and gone
 * again in well under two seconds. It sits above the bar while the bar shows.
 */
export function Toast({ barVisible }: { barVisible: boolean }) {
  const toast = useRuya((s) => s.toast);
  if (!toast) return null;

  return (
    <div
      key={toast.id}
      role="status"
      className="pointer-events-none absolute left-1/2 z-[8] whitespace-nowrap rounded border border-foreground/15 bg-stage/80 px-[18px] py-[9px] font-mono text-[12.5px] tabular-nums backdrop-blur-sm [animation:ry-rise_1.4s_ease_both]"
      style={{ bottom: barVisible ? 148 : 58 }}
    >
      {toast.text}
    </div>
  );
}
