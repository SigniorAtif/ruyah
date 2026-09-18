'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionOverlay, PlayerOverlay } from './ConnectionOverlay';
import { ControlBar } from './ControlBar';
import { SyncIndicator } from './SyncIndicator';
import { Toast } from './Toast';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { fingerprintsMatch, getEngine, nameOf, useRuya } from '@/lib/store';

const CONTROLS_IDLE_MS = 3_000;
/** The "keys" hint in the bar is for the first couple of minutes only. */
const KEYS_HINT_MS = 120_000;

export function VideoPlayer({ code }: { code: string }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [mismatchDismissed, setMismatchDismissed] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [showKeysHint, setShowKeysHint] = useState(true);

  const objectUrl = useRuya((s) => s.objectUrl);
  const roomCode = useRuya((s) => s.roomCode);
  const ensureEngine = useRuya((s) => s.ensureEngine);
  const status = useRuya((s) => s.status);
  const fingerprint = useRuya((s) => s.fingerprint);
  const peerFingerprint = useRuya((s) => s.peerFingerprint);
  const setReady = useRuya((s) => s.setReady);
  const leave = useRuya((s) => s.leave);

  const sameEncode = fingerprintsMatch(fingerprint, peerFingerprint);

  useKeyboardShortcuts(containerRef, {
    onToggleKeys: () => setKeysOpen((v) => !v),
    onEscape: () => setKeysOpen(false),
  });

  // A hard load of /room/CODE has no File — it cannot survive a URL — so send
  // them back to pick it rather than showing a dead player (§8: never make
  // anyone re-pick unnecessarily, but here there is nothing to keep).
  useEffect(() => {
    if (!objectUrl || roomCode !== code) router.replace('/');
  }, [objectUrl, roomCode, code, router]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !objectUrl) return;
    const engine = ensureEngine();
    if (!engine) return;
    return engine.attach(video);
  }, [objectUrl, ensureEngine]);

  const wake = useCallback(() => {
    setControlsVisible(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
  }, []);

  // Controls start visible and fade on their own; the timer is armed here
  // rather than by calling wake(), which would set state during the effect.
  useEffect(() => {
    idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
    const hint = setTimeout(() => setShowKeysHint(false), KEYS_HINT_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      clearTimeout(hint);
    };
  }, []);

  if (!objectUrl) return null;

  const connectionDown = !!status && status.connection !== 'ok';
  const mediaError = status?.mediaError ?? null;
  const blocked = connectionDown || !!mediaError;
  // Nobody wants the bar to vanish from under an open panel, or while paused.
  const barVisible = controlsVisible || keysOpen || blocked || !status?.playing;

  const chooseAnotherFile = () => {
    // Back to the room screen, file picker first. Un-readying keeps the room
    // screen from bouncing straight back here.
    setReady(false);
    router.push('/');
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={wake}
      onTouchStart={wake}
      // h-dvh, not flex-1: the <video> needs a definite height to resolve
      // h-full against, or it falls back to its intrinsic size and pushes the
      // control bar off the bottom of the screen.
      className={`relative h-dvh w-full overflow-hidden bg-stage ${barVisible ? '' : 'cursor-none'}`}
    >
      <video
        ref={videoRef}
        src={objectUrl}
        onClick={() => {
          wake();
          getEngine()?.togglePlay();
        }}
        className="absolute inset-0 h-full w-full object-contain transition-[filter] duration-700"
        style={{ filter: blocked || keysOpen ? 'blur(8px)' : undefined }}
        playsInline
        // No `controls`: every action routes through PlayerEngine (§11).
      />

      {/* Outside ControlBar on purpose: the sync state stays readable when the
          bar has faded (rule 6). */}
      <SyncIndicator />

      {sameEncode === false && !mismatchDismissed && (
        <div
          role="status"
          className="absolute inset-x-0 top-0 z-[7] flex items-start gap-3.5 border-b border-warn/40 bg-stage/85 px-6 py-3.5 backdrop-blur-md [animation:ry-in_.5s_cubic-bezier(.2,.8,.2,1)_both]"
        >
          <span aria-hidden className="flex-none font-mono text-xs leading-normal text-warn">
            ⚠
          </span>
          <p className="max-w-[820px] flex-1 text-[13.5px] leading-[1.55] text-warn">
            You are watching different encodes. Timestamps may not line up, so
            the same moment can land at different points in each copy.
          </p>
          <button
            type="button"
            onClick={() => setMismatchDismissed(true)}
            className="flex-none cursor-pointer border-0 bg-transparent py-0 pl-3 pr-0 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors duration-300 hover:text-foreground"
          >
            dismiss
          </button>
        </div>
      )}

      <Toast barVisible={barVisible} />

      {keysOpen && <KeysSheet onClose={() => setKeysOpen(false)} />}

      {mediaError ? (
        <PlayerOverlay
          kicker="media"
          tone="bad"
          title="This file will not play here"
          body={`${mediaError} Nothing is sent anywhere either way.`}
          primary={{ label: 'Choose another file', onClick: chooseAnotherFile }}
          onLeave={leave}
        />
      ) : (
        <ConnectionOverlay onLeave={leave} />
      )}

      <ControlBar
        visible={barVisible}
        containerRef={containerRef}
        showKeysHint={showKeysHint}
        onOpenKeys={() => setKeysOpen(true)}
      />

      <Beat />
    </div>
  );
}

const KEY_ROWS: Array<[string, string]> = [
  ['Space · K', 'play / pause'],
  ['← →', 'seek ±5s'],
  ['J · L', 'seek ±10s'],
  ['↑ ↓', 'volume ±5%'],
  ['M', 'mute'],
  ['F', 'fullscreen'],
  ['0 – 9', 'jump to 0–90%'],
  ['?', 'this sheet'],
];

function KeysSheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      className="absolute inset-0 z-[12] flex items-center justify-center bg-stage/70 p-8 backdrop-blur-sm [animation:ry-in-soft_.35s_ease_both]"
    >
      <div className="w-[min(620px,100%)] rounded border border-foreground/15 bg-[rgba(25,23,21,0.96)] p-[clamp(26px,4vw,40px)] [animation:ry-pop_.45s_cubic-bezier(.2,.8,.2,1)_both]">
        <h3 className="mb-1.5 font-display text-[34px] font-light">Keys</h3>
        <div className="mb-6 h-px w-11 bg-gold" />
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-x-8 font-mono text-[11.5px] text-muted">
          {KEY_ROWS.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-line-soft py-[9px]">
              <dt className="text-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-[22px] text-[12.5px] leading-[1.7] text-faint">
          Anywhere, anytime. Seeks and pauses reach both players; volume stays yours.
        </p>
      </div>
    </div>
  );
}

/**
 * The beat between the room and the film: both names meet, "together now",
 * then the frame. It only ever covers the stage — it takes no clicks and holds
 * nothing up, so the engine's scheduled start is never delayed by it.
 */
function Beat() {
  const me = useRuya((s) => s.displayName);
  const peerUserId = useRuya((s) => s.peerUserId);
  const [phase, setPhase] = useState<'names' | 'line' | 'fade' | 'done'>('names');

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase('line'), 900),
      setTimeout(() => setPhase('fade'), 2_000),
      setTimeout(() => setPhase('done'), 2_600),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  if (phase === 'done') return null;

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-[60] flex items-center justify-center transition-colors duration-[1400ms] ${
        phase === 'names' ? 'bg-panel' : 'bg-stage'
      } ${phase === 'fade' ? '[animation:ry-fade-out_.6s_ease_both]' : ''}`}
    >
      {phase === 'names' && (
        <div className="flex flex-col items-center gap-[18px] px-4">
          <div className="flex items-center gap-[22px]">
            <span className="font-display text-[clamp(26px,3.4vw,38px)] font-light [animation:ry-meet-l_.8s_cubic-bezier(.2,.8,.2,1)_both]">
              {me || 'You'}
            </span>
            <span className="h-px w-10 bg-ok [animation:ry-rule_.9s_.2s_cubic-bezier(.2,.8,.2,1)_both]" />
            <span className="font-display text-[clamp(26px,3.4vw,38px)] font-light [animation:ry-meet-r_.8s_cubic-bezier(.2,.8,.2,1)_both]">
              {nameOf(peerUserId)}
            </span>
          </div>
          <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ok [animation:ry-in-soft_.8s_.35s_ease_both]">
            both ready
          </p>
        </div>
      )}
      {phase !== 'names' && (
        <p className="font-display text-[clamp(28px,4vw,44px)] font-light italic text-foreground/70 [animation:ry-in-soft_1s_ease_both]">
          together now
        </p>
      )}
    </div>
  );
}
