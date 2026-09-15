'use client';

import { useRuya } from '@/lib/store';

/**
 * Rule 7 — the control bar is hidden most of the time, so a keyboard action
 * needs to say what it did. Centred low, out of the frame's way, and gone
 * again in well under two seconds.
 */
export function Toast() {
  const toast = useRuya((s) => s.toast);
  if (!toast) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center">
      <div
        key={toast.id}
        className="rounded-full bg-black/70 px-4 py-2 font-mono text-xs text-white/90 backdrop-blur"
      >
        {toast.text}
      </div>
    </div>
  );
}
