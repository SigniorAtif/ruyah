'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionOverlay } from './ConnectionOverlay';
import { ControlBar } from './ControlBar';
import { DevPanel } from './DevPanel';
import { SyncIndicator } from './SyncIndicator';
import { Toast } from './Toast';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { fingerprintsMatch, useRuya } from '@/lib/store';

const CONTROLS_IDLE_MS = 3_000;

export function VideoPlayer({ code }: { code: string }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [mismatchDismissed, setMismatchDismissed] = useState(false);

  const objectUrl = useRuya((s) => s.objectUrl);
  const roomCode = useRuya((s) => s.roomCode);
  const ensureEngine = useRuya((s) => s.ensureEngine);
  const status = useRuya((s) => s.status);
  const fingerprint = useRuya((s) => s.fingerprint);
  const peerFingerprint = useRuya((s) => s.peerFingerprint);

  const sameEncode = fingerprintsMatch(fingerprint, peerFingerprint);

  useKeyboardShortcuts(containerRef);

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
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  if (!objectUrl) return null;

  return (
    <div
      ref={containerRef}
      onMouseMove={wake}
      onTouchStart={wake}
      // h-dvh, not flex-1: the <video> needs a definite height to resolve
      // h-full against, or it falls back to its intrinsic size and pushes the
      // control bar off the bottom of the screen.
      className={`relative h-dvh w-full overflow-hidden bg-black ${
        controlsVisible ? '' : 'cursor-none'
      }`}
    >
      <video
        ref={videoRef}
        src={objectUrl}
        className="h-full w-full object-contain"
        playsInline
        // No `controls`: every action routes through PlayerEngine (§11).
      />

      {/* Outside ControlBar on purpose: the sync state stays readable when the
          bar has faded (rule 6). */}
      <SyncIndicator />
      <Toast />
      <ControlBar visible={controlsVisible} containerRef={containerRef} />
      <ConnectionOverlay />
      <DevPanel />

      {status?.mediaError && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/85 px-8 text-center">
          <p className="max-w-sm text-xs leading-relaxed text-bad">{status.mediaError}</p>
        </div>
      )}

      {sameEncode === false && !mismatchDismissed && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-start gap-3 bg-warn/10 px-4 py-2 text-[11px] text-warn backdrop-blur">
          <p className="flex-1">
            ⚠ You are watching different encodes. If one of you has an extra
            intro, set a manual offset instead of seeking — the offset control is
            in the bar below.
          </p>
          <button
            type="button"
            onClick={() => setMismatchDismissed(true)}
            className="shrink-0 underline-offset-2 hover:underline"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}
