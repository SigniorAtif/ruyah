'use client';

import { useCallback, useRef, useState } from 'react';
import { formatBytes, formatClock, shortFingerprint } from '@/lib/player/fingerprint';
import { useRuya } from '@/lib/store';

/**
 * The right-hand column of the room, above the partner card: pick a file, watch
 * it being read, then see what was read. One hidden input serves every state so
 * "choose a different file" and the drop target behave the same.
 */
export function FileDropZone() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const file = useRuya((s) => s.file);
  const duration = useRuya((s) => s.duration);
  const fileError = useRuya((s) => s.fileError);
  const fingerprint = useRuya((s) => s.fingerprint);
  const fingerprintStatus = useRuya((s) => s.fingerprintStatus);
  const setFile = useRuya((s) => s.setFile);

  const accept = useCallback(
    (picked: File | undefined | null) => {
      if (picked) void setFile(picked);
    },
    [setFile],
  );
  const browse = () => inputRef.current?.click();

  const reading = !!file && !fileError && fingerprintStatus === 'hashing';
  const read = !!file && !fileError && !reading;

  return (
    <>
      {fileError && file && (
        <div
          role="alert"
          className="rounded border border-bad/50 px-[22px] py-5 [animation:ry-in_.45s_cubic-bezier(.2,.8,.2,1)_both]"
        >
          <p className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-bad">
            media · cannot decode
          </p>
          <p className="mb-2 font-display text-xl font-semibold">
            This browser will not play {extensionOf(file.name)}
          </p>
          <p className="mb-3.5 text-[13.5px] leading-[1.7] text-muted">
            Your copy is untouched and nothing was sent anywhere. {fileError}
          </p>
          <p className="truncate border-t border-line-soft pt-[11px] font-mono text-[11px] text-faint">
            {file.name}
          </p>
        </div>
      )}

      {(!file || fileError) && (
        <div
          role="button"
          tabIndex={0}
          onClick={browse}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              browse();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            accept(e.dataTransfer.files?.[0]);
          }}
          className={`cursor-pointer rounded border border-dashed px-8 py-[clamp(36px,5vw,56px)] text-center transition-[border-color,background-color,transform] duration-400 hover:border-gold/60 active:scale-[.995] ${
            dragging ? 'border-gold bg-gold/8' : 'border-line-strong bg-transparent'
          }`}
        >
          <h3 className="mb-2.5 font-display text-[clamp(22px,2.4vw,27px)] font-semibold">
            {dragging ? 'Let go to read it' : 'Choose your copy of the film'}
          </h3>
          <p className="mb-[18px] text-[13.5px] leading-[1.7] text-muted">
            Drop it here, or click to browse. It never leaves your machine.
          </p>
          <p className="font-mono text-[10px] tracking-[0.14em] text-faint">
            .mp4 · .webm · .mov · .mkv if your browser decodes it
          </p>
        </div>
      )}

      {reading && (
        <div className="rounded border border-line px-6 py-[22px] [animation:ry-in_.4s_ease_both]">
          <div className="mb-3.5 flex items-baseline justify-between gap-4">
            <span className="font-display text-[19px] font-semibold">Reading your copy</span>
            <span className="truncate font-mono text-[11px] text-gold-hi">{file.name}</span>
          </div>
          {/* Hashing reports no progress, so this sweeps rather than fills. */}
          <div className="relative h-0.5 overflow-hidden bg-foreground/15">
            <div className="absolute inset-y-0 left-0 w-1/3 bg-gold [animation:ry-sweep_1.2s_ease-in-out_infinite]" />
          </div>
          <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.12em] text-faint">
            fingerprint · head, tail and size
          </p>
        </div>
      )}

      {read && (
        <div className="[animation:ry-in_.5s_cubic-bezier(.2,.8,.2,1)_both]">
          <button
            type="button"
            onClick={browse}
            className="mb-[22px] cursor-pointer rounded border border-line-strong bg-transparent px-[18px] py-[11px] font-display text-[15px] font-semibold transition-colors duration-300 hover:border-gold hover:text-gold-hi"
          >
            Choose a different file
          </button>
          <dl className="border-t border-line-soft">
            <Row label="file" value={file.name} delay={0} />
            <Row label="size" value={formatBytes(file.size)} delay={0.07} />
            <Row label="duration" value={formatClock(duration)} delay={0.14} />
            <Row
              label="hash"
              value={
                fingerprintStatus === 'error'
                  ? 'could not hash this file'
                  : fingerprint
                    ? shortFingerprint(fingerprint)
                    : '—'
              }
              delay={0.21}
            />
          </dl>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mp4,.mkv,.webm,.mov"
        className="hidden"
        onChange={(e) => {
          accept(e.target.files?.[0]);
          // Picking the same file again after an error should still fire.
          e.target.value = '';
        }}
      />
    </>
  );
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : 'this file';
}

function Row({ label, value, delay }: { label: string; value: string; delay: number }) {
  return (
    <div
      className="flex gap-[18px] border-b border-line-soft py-[13px] [animation:ry-in_.5s_cubic-bezier(.2,.8,.2,1)_both]"
      style={{ animationDelay: `${delay}s` }}
    >
      <dt className="kicker w-[88px] flex-none">{label}</dt>
      <dd className="truncate font-mono text-xs">{value}</dd>
    </div>
  );
}
