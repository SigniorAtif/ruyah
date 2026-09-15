'use client';

import { useState } from 'react';
import { nameOf, useRuya } from '@/lib/store';

/**
 * §8 — a lost connection is not a drift problem, so nothing here tries to claw
 * anything back. It says which of the two situations this is, because "waiting
 * for her connection" and "you've lost connection" are different things for the
 * person reading it.
 */
export function ConnectionOverlay() {
  const status = useRuya((s) => s.status);
  const peerUserId = useRuya((s) => s.peerUserId);
  const reconnect = useRuya((s) => s.reconnect);
  const [retrying, setRetrying] = useState(false);
  const connection = status?.connection ?? 'connecting';
  if (connection === 'ok') return null;

  const her = nameOf(peerUserId);
  const copy: Record<string, { title: string; body: string }> = {
    connecting: {
      title: 'Connecting…',
      body: 'Lining up the clocks.',
    },
    'peer-lost': {
      title: `Waiting for ${her}'s connection…`,
      body: `Both of you are paused. Your file is still loaded — when ${her} is back you will pick up together, from whichever of you is further behind.`,
    },
    'self-lost': {
      title: "You've lost connection",
      body: `${her} has been paused too. Nothing is lost: your file stays loaded and the room is still yours.`,
    },
    reconnecting: {
      title: 'Reconnecting…',
      body: 'Measuring the clocks again from scratch before starting.',
    },
  };
  const { title, body } = copy[connection] ?? copy.connecting;

  // `disconnected` is the one state that never resolves itself: nothing is
  // retrying, so without this the only way out is a reload, which discards the
  // loaded File that the copy above has just promised to keep.
  const stuck = connection === 'self-lost';

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="max-w-sm px-8 text-center">
        <p className="text-sm">{title}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">{body}</p>
        {stuck && (
          <button
            type="button"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              try {
                await reconnect();
              } finally {
                setRetrying(false);
              }
            }}
            className="mt-4 rounded border border-line px-3 py-1 text-xs text-foreground disabled:opacity-50 hover:bg-line/40"
          >
            {retrying ? 'Reconnecting…' : 'Try again'}
          </button>
        )}
      </div>
    </div>
  );
}
