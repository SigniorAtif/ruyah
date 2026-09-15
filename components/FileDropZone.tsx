'use client';

import { useCallback, useRef, useState } from 'react';
import { formatBytes, formatClock, shortFingerprint } from '@/lib/player/fingerprint';
import { useRuya } from '@/lib/store';

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

  return (
    <div>
      <div
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
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center transition-colors ${
          dragging ? 'border-accent bg-accent/5' : 'border-line hover:border-muted'
        }`}
      >
        <p className="text-sm">
          {file ? 'Choose a different file' : 'Choose your copy of the film'}
        </p>
        <p className="mt-1 text-xs text-muted">
          Drag it here, or click to browse. It never leaves your machine.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,.mp4,.mkv,.webm,.mov"
          className="hidden"
          onChange={(e) => accept(e.target.files?.[0])}
        />
      </div>

      {file && (
        <dl className="mt-4 space-y-1.5 text-xs">
          <Row label="File" value={file.name} mono />
          <Row label="Size" value={formatBytes(file.size)} />
          <Row
            label="Duration"
            value={duration > 0 ? formatClock(duration) : fileError ? '—' : 'reading…'}
          />
          <Row
            label="Fingerprint"
            mono
            value={
              fingerprintStatus === 'hashing'
                ? 'hashing head + tail…'
                : fingerprintStatus === 'error'
                  ? 'could not hash this file'
                  : fingerprint
                    ? shortFingerprint(fingerprint)
                    : '—'
            }
          />
        </dl>
      )}

      {fileError && (
        <p className="mt-3 rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          {fileError}
        </p>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className={`truncate text-right ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
