'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { formatClock } from '@/lib/player/fingerprint';
import { getEngine, useRuya } from '@/lib/store';

const SEEK_SMALL_S = 5;
const SEEK_LARGE_S = 10;
const VOLUME_STEP = 0.05;

/**
 * Whether the focused element should keep this key for itself.
 *
 * Rule 5 is about not stealing typing, but the same reasoning covers native
 * activation: Space on a focused button must press that button, and arrows on a
 * focused slider must move that slider. Anything else and keyboard users lose
 * the controls entirely. Every other key still reaches the shortcuts.
 */
function defersToTarget(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const activation = key === ' ' || key === 'Enter';
  const arrowish = [
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ].includes(key);

  switch (target.tagName) {
    case 'TEXTAREA':
    case 'SELECT':
      return true;
    case 'INPUT': {
      const type = (target as HTMLInputElement).type;
      // The chat input lands here; a text field keeps every key.
      if (!['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(type)) {
        return true;
      }
      return type === 'range' ? arrowish || activation : activation;
    }
    case 'BUTTON':
    case 'A':
      return activation;
    default:
      return false;
  }
}

export interface ShortcutHandlers {
  /** `?` — show or hide the keys sheet. */
  onToggleKeys?: () => void;
  /** Escape — close whatever panel is open. */
  onEscape?: () => void;
  /** `c` — show or hide the chat aside. */
  onToggleChat?: () => void;
  /** `h` — the hold-on picker. */
  onHold?: () => void;
}

export function useKeyboardShortcuts(
  containerRef: RefObject<HTMLDivElement | null>,
  handlers: ShortcutHandlers = {},
) {
  // Held in a ref so a new closure each render does not re-bind the listener.
  const handlersRef = useRef(handlers);
  const lastTextTrack = useRef(-1);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape never belongs to the focused element here, and it must work
      // even from inside a panel's own controls.
      if (event.key === 'Escape') {
        handlersRef.current.onEscape?.();
        return;
      }
      // Leave the browser's own chords alone. Shift is allowed: `?` needs it.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat && event.key === ' ') return; // holding space is not a rattle of toggles
      if (defersToTarget(event.target, event.key)) return;

      if (event.key === '?') {
        handlersRef.current.onToggleKeys?.();
        return;
      }

      const engine = getEngine();
      const { status, showToast } = useRuya.getState();
      if (!engine || !status) return;

      const key = event.key;
      const seekBy = (delta: number) => {
        // Rule 3: never touches video.currentTime — the engine coalesces the
        // burst and broadcasts one command, so anti-echo and §6.3 still apply.
        const moved = engine.seekBy(delta);
        if (!moved) return;
        const sign = moved.delta >= 0 ? '+' : '−';
        showToast(`${sign}${Math.abs(Math.round(moved.delta))}s · ${formatClock(moved.target)}`);
      };

      const setVolume = (next: number) => {
        const clamped = Math.min(1, Math.max(0, next));
        // Volume is local: it never reaches the transport (rule 1).
        engine.setVolume(clamped);
        if (clamped > 0 && status.muted) engine.setMuted(false);
        showToast(clamped === 0 ? 'Muted' : `Volume ${Math.round(clamped * 100)}%`);
      };

      switch (key) {
        case ' ':
        case 'k':
        case 'K':
          event.preventDefault(); // rule 4: no page scroll
          engine.togglePlay();
          return;

        case 'ArrowLeft':
          event.preventDefault();
          seekBy(-SEEK_SMALL_S);
          return;
        case 'ArrowRight':
          event.preventDefault();
          seekBy(SEEK_SMALL_S);
          return;
        case 'j':
        case 'J':
          seekBy(-SEEK_LARGE_S);
          return;
        case 'l':
        case 'L':
          seekBy(SEEK_LARGE_S);
          return;

        case 'ArrowUp':
          event.preventDefault();
          setVolume((status.muted ? 0 : status.volume) + VOLUME_STEP);
          return;
        case 'ArrowDown':
          event.preventDefault();
          setVolume((status.muted ? 0 : status.volume) - VOLUME_STEP);
          return;

        case 'm':
        case 'M': {
          const next = !status.muted;
          engine.setMuted(next);
          showToast(next ? 'Muted' : `Volume ${Math.round(status.volume * 100)}%`);
          return;
        }

        case 'c':
        case 'C':
          handlersRef.current.onToggleChat?.();
          return;

        case 'h':
        case 'H':
          handlersRef.current.onHold?.();
          return;

        case 's':
        case 'S': {
          // Off goes back to whichever track was last on, or the first one.
          if (status.activeTextTrack >= 0) {
            lastTextTrack.current = status.activeTextTrack;
            engine.setTextTrack(-1);
            showToast('Subtitles off');
            return;
          }
          const tracks = status.textTracks;
          const next =
            tracks.find((t) => t.index === lastTextTrack.current) ?? tracks[0];
          if (!next) {
            showToast('No subtitles loaded');
            return;
          }
          engine.setTextTrack(next.index);
          showToast(`Subtitles · ${next.label || next.language || 'on'}`);
          return;
        }

        case 'f':
        case 'F': {
          const el = containerRef.current;
          if (!el) return;
          // Fullscreen is a property of this browser window, not of the film.
          if (document.fullscreenElement) void document.exitFullscreen();
          else void el.requestFullscreen();
          return;
        }

        default:
          break;
      }

      if (key >= '0' && key <= '9') {
        if (!status.duration) return;
        event.preventDefault();
        // An absolute jump, so it does not join the coalescing burst.
        const target = (status.duration * Number(key)) / 10;
        engine.seek(target);
        useRuya.getState().showToast(`Jump to ${formatClock(target)}`);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [containerRef]);
}
