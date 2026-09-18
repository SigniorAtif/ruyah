/**
 * Local subtitle files. Browsers only render WebVTT through <track>, so an SRT
 * is rewritten into VTT here. Nothing leaves the machine: the file is read and
 * handed back to the <video> as a blob URL, like the film itself.
 */

export const SUBTITLE_ACCEPT = '.srt,.vtt,text/vtt,application/x-subrip';

/** SRT and VTT differ in the header and the decimal mark; cues are otherwise the same. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // 00:01:02,345 --> 00:01:04,000  becomes  00:01:02.345 --> 00:01:04.000
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

/** Read a picked .srt or .vtt as WebVTT text, or throw with a readable reason. */
export async function readSubtitleFile(file: File): Promise<string> {
  const text = await file.text();
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('WEBVTT')) return text;
  if (/\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(text)) return srtToVtt(text);
  throw new Error('That file does not look like .srt or .vtt subtitles.');
}

/** "Film.en.srt" -> "Film.en", for the track's label. */
export function subtitleLabel(file: File): string {
  return file.name.replace(/\.(srt|vtt)$/i, '') || 'Subtitles';
}
