/**
 * Pulls one audio track, or the subtitle text, out of a local file with
 * ffmpeg.wasm, so a browser that can only play a file's first audio track can
 * still play the one asked for, and subtitles buried in an MKV can be shown.
 *
 * The film is never copied into memory: it is mounted read-only (WORKERFS) and
 * ffmpeg reads the parts it needs straight from disk. Only the audio it writes
 * lives in memory, and nothing leaves the machine — the ffmpeg core is the one
 * thing downloaded, once, and the browser caches it.
 */

import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { browserPlays, type AudioCodec } from './probe';

/** Pinned to the version @ffmpeg/ffmpeg 0.12 expects. Single-threaded: no COOP/COEP needed. */
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

let corePromise: Promise<{ coreURL: string; wasmURL: string }> | null = null;

function coreUrls() {
  corePromise ??= (async () => {
    const { toBlobURL } = await import('@ffmpeg/util');
    return {
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    };
  })();
  // A failed download should be retryable, not cached forever.
  corePromise.catch(() => {
    corePromise = null;
  });
  return corePromise;
}

/** How the extracted track is written: copied as-is where the browser can play it. */
function outputFor(codec: AudioCodec): { name: string; type: string; args: string[] } {
  switch (codec) {
    case 'aac':
      return { name: 'out.m4a', type: 'audio/mp4', args: ['-c:a', 'copy'] };
    case 'mp3':
      return { name: 'out.mp3', type: 'audio/mpeg', args: ['-c:a', 'copy'] };
    case 'opus':
    case 'vorbis':
      return { name: 'out.webm', type: 'audio/webm', args: ['-c:a', 'copy'] };
    default:
      // AC3, E-AC3, DTS, TrueHD and anything unknown: decode and re-encode to
      // stereo AAC. FLAC and PCM too — they play, but copied they run to
      // gigabytes of memory for a feature film.
      return {
        name: 'out.m4a',
        type: 'audio/mp4',
        args: ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'],
      };
  }
}

/** Whether pulling this track out means re-encoding it (slow) rather than copying (fast). */
export function needsTranscode(codec: AudioCodec): boolean {
  return !browserPlays(codec) || codec === 'flac' || codec === 'pcm';
}

export class AbortedError extends Error {
  constructor() {
    super('Extraction was cancelled.');
  }
}

/**
 * Run one ffmpeg command against the film, mounted read-only at /in, and hand
 * back the named output files. `onProgress` gets the seconds of output
 * written so far.
 */
async function runFfmpeg(
  file: File,
  args: (input: string) => string[],
  outputs: string[],
  onProgress: (seconds: number) => void,
  signal: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  const [{ FFmpeg, FFFSType }, urls] = await Promise.all([import('@ffmpeg/ffmpeg'), coreUrls()]);
  if (signal.aborted) throw new AbortedError();

  const ffmpeg: FFmpeg = new FFmpeg();
  const abort = () => ffmpeg.terminate();
  signal.addEventListener('abort', abort, { once: true });

  try {
    // The worker is served unbundled from public/ (scripts/copy-ffmpeg-worker.mjs):
    // bundled, its runtime import of the core is rewritten and fails.
    await ffmpeg.load({ ...urls, classWorkerURL: new URL('/ffmpeg/worker.js', location.href).href });
    await ffmpeg.createDir('/in');
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, '/in');

    // The progress event stays at zero for a stream copy, and the usual status
    // line ends in \r, so it only reaches the log at the end. `-progress pipe:1`
    // writes one "out_time=HH:MM:SS.us" line at a time instead.
    ffmpeg.on('log', ({ message }) => {
      const m = /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });

    const code = await ffmpeg.exec(['-nostdin', '-progress', 'pipe:1', ...args(`/in/${file.name}`)]);
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);

    const result = new Map<string, Uint8Array>();
    for (const name of outputs) {
      const data = await ffmpeg.readFile(name);
      if (typeof data === 'string') throw new Error('ffmpeg returned text, not bytes');
      result.set(name, data);
    }
    return result;
  } catch (err) {
    if (signal.aborted) throw new AbortedError();
    throw err;
  } finally {
    signal.removeEventListener('abort', abort);
    // Frees the worker and all of its memory, output included.
    if (!signal.aborted) ffmpeg.terminate();
  }
}

/** The cache slot and media type an extracted audio track is stored under. */
export function audioSlot(index: number, codec: AudioCodec): { slot: string; type: string } {
  const out = outputFor(codec);
  return { slot: `audio-${index}-${out.name}`, type: out.type };
}

/**
 * Extract audio track `audioIndex` (ffmpeg's `0:a:N`) as a playable Blob.
 * `onProgress` gets the seconds of audio written so far.
 */
export async function extractAudioTrack(
  file: File,
  audioIndex: number,
  codec: AudioCodec,
  onProgress: (seconds: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const out = outputFor(codec);
  const files = await runFfmpeg(
    file,
    (input) => ['-i', input, '-map', `0:a:${audioIndex}`, '-vn', '-sn', '-dn', ...out.args, out.name],
    [out.name],
    onProgress,
    signal,
  );
  return new Blob([files.get(out.name) as BlobPart], { type: out.type });
}

/**
 * Extract text subtitle tracks (ffmpeg's `0:s:N`) as WebVTT, all in one pass
 * over the file: the subtitle packets are spread through the whole film, so
 * each extra pass would cost as much as the first. ASS styling is dropped;
 * the words and their timing are what survive.
 */
export async function extractSubtitleTracks(
  file: File,
  indices: number[],
  onProgress: (seconds: number) => void,
  signal: AbortSignal,
): Promise<Map<number, string>> {
  const name = (i: number) => `sub-${i}.vtt`;
  const files = await runFfmpeg(
    file,
    (input) => [
      '-i',
      input,
      ...indices.flatMap((i) => ['-map', `0:s:${i}`, '-c:s', 'webvtt', name(i)]),
    ],
    indices.map(name),
    onProgress,
    signal,
  );
  const decoder = new TextDecoder();
  return new Map(indices.map((i) => [i, decoder.decode(files.get(name(i)))]));
}
