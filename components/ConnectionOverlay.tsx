'use client';

import { useState, type ReactNode } from 'react';
import { nameOf, useRuya } from '@/lib/store';

/**
 * §8 — a lost connection is not a drift problem, so nothing here tries to claw
 * anything back. It says which of the two situations this is, because "waiting
 * for their connection" and "you've lost connection" are different things for
 * the person reading it.
 */
export function ConnectionOverlay({
  onLeave,
}: {
  onLeave: () => void;
}) {
  const status = useRuya((s) => s.status);
  const peerUserId = useRuya((s) => s.peerUserId);
  const reconnect = useRuya((s) => s.reconnect);
  const [retrying, setRetrying] = useState(false);
  const connection = status?.connection ?? 'connecting';
  if (connection === 'ok') return null;

  const them = nameOf(peerUserId);
  const copy: Record<string, { title: string; body: string }> = {
    connecting: {
      title: 'Connecting…',
      body: 'Lining up the clocks.',
    },
    'peer-lost': {
      title: `Waiting for ${them}'s connection…`,
      body: `Both of you are paused. Your file is still loaded — when ${them} is back you will pick up together, from whichever of you is further behind.`,
    },
    'self-lost': {
      title: "You've lost connection",
      body: `${them} has been paused too. Nothing is lost: your file stays loaded and the room is still yours.`,
    },
    reconnecting: {
      title: 'Connection lost — reconnecting',
      body: 'Playback is paused for both of you. The film is untouched; only the timing link dropped. The clocks are measured again from scratch before starting.',
    },
  };
  const { title, body } = copy[connection] ?? copy.connecting;

  // `disconnected` is the one state that never resolves itself: nothing is
  // retrying, so without this the only way out is a reload, which discards the
  // loaded File that the copy above has just promised to keep.
  const stuck = connection === 'self-lost';

  return (
    <PlayerOverlay
      kicker="transport"
      tone="warn"
      spinner={!stuck}
      title={title}
      body={body}
      primary={
        stuck
          ? {
              label: retrying ? 'Reconnecting…' : 'Try again',
              disabled: retrying,
              onClick: async () => {
                setRetrying(true);
                try {
                  await reconnect();
                } finally {
                  setRetrying(false);
                }
              },
            }
          : undefined
      }
      onLeave={onLeave}
    />
  );
}

/** The centred card every blocking player state uses: dropout, media error. */
export function PlayerOverlay({
  kicker,
  tone,
  spinner,
  title,
  body,
  primary,
  onLeave,
  footer,
}: {
  kicker: string;
  tone: 'warn' | 'bad';
  spinner?: boolean;
  title: string;
  body: string;
  primary?: { label: string; onClick: () => void; disabled?: boolean };
  onLeave: () => void;
  footer?: ReactNode;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={title}
      className="absolute inset-0 z-[11] flex items-center justify-center bg-stage/65 p-8 backdrop-blur-[3px] [animation:ry-in-soft_.5s_ease_both]"
    >
      <div className="w-[min(520px,100%)] text-center [animation:ry-pop_.5s_cubic-bezier(.2,.8,.2,1)_both]">
        {spinner && (
          <div className="mx-auto mb-[26px] h-[26px] w-[26px] rounded-full border border-foreground/20 border-t-gold [animation:ry-spin_1.2s_linear_infinite]" />
        )}
        <p
          className={`mb-3.5 font-mono text-[9.5px] uppercase tracking-[0.2em] ${
            tone === 'warn' ? 'text-warn' : 'text-bad'
          }`}
        >
          {kicker}
        </p>
        <h3 className="mb-4 font-display text-[clamp(28px,3.6vw,40px)] font-light leading-[1.12]">
          {title}
        </h3>
        <p className="mx-auto mb-7 max-w-[400px] text-sm leading-[1.8] text-muted">{body}</p>
        <div className="flex flex-wrap justify-center gap-3.5">
          {primary && (
            <button
              type="button"
              onClick={primary.onClick}
              disabled={primary.disabled}
              className="cursor-pointer rounded border border-gold bg-transparent px-[26px] py-[13px] font-display text-base font-semibold text-gold-hi transition-colors duration-400 hover:bg-gold/15 hover:text-foreground"
            >
              {primary.label}
            </button>
          )}
          <button
            type="button"
            onClick={onLeave}
            className="cursor-pointer rounded border border-foreground/20 bg-transparent px-[22px] py-[13px] font-display text-base text-muted transition-colors duration-300 hover:border-foreground/40 hover:text-foreground"
          >
            Leave room
          </button>
        </div>
        {footer}
      </div>
    </div>
  );
}
