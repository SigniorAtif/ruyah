'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { frameBox, type FrameBox } from '@/lib/player/frame';
import { nameOf, useRuya } from '@/lib/store';

/** Sending on every mousemove would be a hundred frames a second. */
const SEND_EVERY_MS = 60;

/**
 * Hold P and a dot follows your cursor on both screens — for "look at that",
 * without describing where. The spot travels as a fraction of the picture, so
 * it lands in the same place whatever shape the other window is.
 */
export function FramePointer({
  videoRef,
  pointing,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  pointing: boolean;
}) {
  const sendPoint = useRuya((s) => s.sendPoint);
  const peerPoint = useRuya((s) => s.peerPoint);
  const peerUserId = useRuya((s) => s.peerUserId);
  const [mine, setMine] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<FrameBox | null>(null);
  const lastSent = useRef(0);

  // The picture's box changes with the window, fullscreen and the aside.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const measure = () => setBox(frameBox(video));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener('loadedmetadata', measure);
    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', measure);
    };
  }, [videoRef]);

  useEffect(() => {
    if (!pointing) return;
    const onMove = (event: PointerEvent) => {
      const video = videoRef.current;
      const b = video && frameBox(video);
      if (!video || !b) return;
      const rect = video.getBoundingClientRect();
      const x = (event.clientX - rect.left - b.left) / b.width;
      const y = (event.clientY - rect.top - b.top) / b.height;
      // Off the picture — over the bars, the aside or the bar — points at nothing.
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      setMine({ x, y });
      const now = event.timeStamp;
      if (now - lastSent.current < SEND_EVERY_MS) return;
      lastSent.current = now;
      sendPoint({ x, y });
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      // Letting go clears it on both screens.
      setMine(null);
      sendPoint(null);
    };
  }, [pointing, sendPoint, videoRef]);

  if (!box) return null;
  const at = (p: { x: number; y: number }) => ({
    left: box.left + p.x * box.width,
    top: box.top + p.y * box.height,
  });

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[7] overflow-hidden">
      <AnimatePresence>
        {mine && <Dot key="mine" style={at(mine)} tone="mine" />}
        {peerPoint && <Dot key="theirs" style={at(peerPoint)} tone="theirs" label={nameOf(peerUserId)} />}
      </AnimatePresence>
    </div>
  );
}

function Dot({
  style,
  tone,
  label,
}: {
  style: { left: number; top: number };
  tone: 'mine' | 'theirs';
  label?: string;
}) {
  const colour = tone === 'mine' ? 'bg-gold-hi' : 'bg-foreground';
  const ring = tone === 'mine' ? 'border-gold-hi' : 'border-foreground';
  const glow =
    tone === 'mine'
      ? 'shadow-[0_0_18px_6px_rgba(214,168,86,0.35)]'
      : 'shadow-[0_0_18px_6px_rgba(240,236,230,0.3)]';
  return (
    <motion.span
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={style}
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6 }}
      transition={{ type: 'spring', stiffness: 500, damping: 34, mass: 0.4 }}
    >
      <span
        className={`block h-3 w-3 rounded-full ${colour} ${glow}`}
      />
      <span
        className={`absolute left-1/2 top-1/2 block h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border ${ring} opacity-50 [animation:ry-pulse_1.6s_ease-in-out_infinite]`}
      />
      {label && (
        <span className="absolute left-5 top-3 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/90 drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]">
          {label}
        </span>
      )}
    </motion.span>
  );
}
