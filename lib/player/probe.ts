/**
 * Lists a local file's audio and subtitle tracks by reading only its headers.
 *
 * Chromium browsers (Chrome, Brave, Edge) play the first audio track of a file
 * and give pages no way to pick another. Knowing what is in the file is the
 * first step to playing the right one ourselves, and it has to be cheap: this
 * reads a few hundred KB of an MP4's `moov` or an MKV's `Tracks`, never the
 * whole film, and never loads ffmpeg.
 */

export type AudioCodec =
  | 'aac'
  | 'mp3'
  | 'opus'
  | 'vorbis'
  | 'flac'
  | 'pcm'
  | 'ac3'
  | 'eac3'
  | 'dts'
  | 'truehd'
  | 'other';

/** Text formats ffmpeg can turn into WebVTT; `image` is PGS/VobSub, which it cannot. */
export type SubtitleCodec = 'ass' | 'srt' | 'webvtt' | 'mov_text' | 'image' | 'other';

export interface ProbedSubtitleTrack {
  /** Position among the file's subtitle tracks, which is also ffmpeg's `0:s:N`. */
  index: number;
  language: string;
  name: string;
  codec: SubtitleCodec;
  isDefault: boolean;
}

export interface ProbedTracks {
  audio: ProbedAudioTrack[];
  subtitles: ProbedSubtitleTrack[];
}

/** Whether a subtitle track can be read out as text. */
export function isTextSubtitle(codec: SubtitleCodec): boolean {
  return codec === 'ass' || codec === 'srt' || codec === 'webvtt' || codec === 'mov_text';
}

export interface ProbedAudioTrack {
  /** Position among the file's audio tracks, which is also ffmpeg's `0:a:N`. */
  index: number;
  /** As written in the file: ISO 639-2 ("eng") or BCP 47 ("en-GB"); '' if unknown. */
  language: string;
  name: string;
  codec: AudioCodec;
  isDefault: boolean;
}

/** Stop looking after this much of the file; headers never run this far. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

async function read(file: File, start: number, length: number): Promise<DataView> {
  const buf = await file.slice(start, Math.min(file.size, start + length)).arrayBuffer();
  return new DataView(buf);
}

function ascii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length && offset + i < view.byteLength; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

function utf8(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  return new TextDecoder().decode(bytes).replace(/\0+$/, '');
}

const NO_TRACKS: ProbedTracks = { audio: [], subtitles: [] };

export async function probeTracks(file: File): Promise<ProbedTracks> {
  const head = await read(file, 0, 16);
  if (head.byteLength >= 4 && head.getUint32(0) === 0x1a45dfa3) return probeMatroska(file);
  if (head.byteLength >= 8 && ascii(head, 4, 4) === 'ftyp') return probeMp4(file);
  return NO_TRACKS;
}

export async function probeAudioTracks(file: File): Promise<ProbedAudioTrack[]> {
  return (await probeTracks(file)).audio;
}

// ===================================================================== MP4

function mp4Codec(fourcc: string): AudioCodec {
  switch (fourcc) {
    case 'mp4a':
      return 'aac'; // almost always AAC; MP3-in-MP4 also uses mp4a and plays too
    case '.mp3':
      return 'mp3';
    case 'Opus':
      return 'opus';
    case 'fLaC':
      return 'flac';
    case 'ac-3':
      return 'ac3';
    case 'ec-3':
      return 'eac3';
    case 'dtsc':
    case 'dtsh':
    case 'dtsl':
    case 'dtse':
      return 'dts';
    case 'mlpa':
      return 'truehd';
    case 'lpcm':
    case 'sowt':
    case 'twos':
    case 'ipcm':
      return 'pcm';
    default:
      return 'other';
  }
}

/** Child boxes of a box payload in `view`, as [type, payloadStart, payloadEnd]. */
function boxes(view: DataView, start: number, end: number): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    const type = ascii(view, p + 4, 4);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push([type, p + header, p + size]);
    p += size;
  }
  return out;
}

function child(view: DataView, start: number, end: number, type: string) {
  return boxes(view, start, end).find(([t]) => t === type);
}

async function probeMp4(file: File): Promise<ProbedTracks> {
  // Walk top-level boxes by their headers until moov, which may sit at the end.
  let p = 0;
  let moov: DataView | null = null;
  while (p < file.size) {
    const h = await read(file, p, 16);
    if (h.byteLength < 8) break;
    let size = h.getUint32(0);
    const type = ascii(h, 4, 4);
    let header = 8;
    if (size === 1) {
      size = Number(h.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = file.size - p;
    }
    if (size < header) break;
    if (type === 'moov') {
      if (size > MAX_SCAN_BYTES) return NO_TRACKS;
      moov = await read(file, p + header, size - header);
      break;
    }
    p += size;
  }
  if (!moov) return NO_TRACKS;

  const tracks: ProbedAudioTrack[] = [];
  const subtitles: ProbedSubtitleTrack[] = [];
  let firstEnabled = -1;
  for (const [type, s, e] of boxes(moov, 0, moov.byteLength)) {
    if (type !== 'trak') continue;
    const mdia = child(moov, s, e, 'mdia');
    if (!mdia) continue;
    const hdlr = child(moov, mdia[1], mdia[2], 'hdlr');
    const handler = hdlr ? ascii(moov, hdlr[1] + 8, 4) : '';
    // 'sbtl' and 'text' are the two handlers MP4 uses for timed text.
    if (handler !== 'soun' && handler !== 'sbtl' && handler !== 'text') continue;

    let language = '';
    const elng = child(moov, mdia[1], mdia[2], 'elng');
    if (elng) language = utf8(moov, elng[1] + 4, elng[2] - elng[1] - 4);
    const mdhd = child(moov, mdia[1], mdia[2], 'mdhd');
    if (!language && mdhd) {
      const version = moov.getUint8(mdhd[1]);
      const packed = moov.getUint16(mdhd[1] + (version === 1 ? 32 : 20));
      const code = [10, 5, 0].map((shift) => String.fromCharCode(((packed >> shift) & 0x1f) + 0x60));
      const iso = code.join('');
      if (/^[a-z]{3}$/.test(iso) && iso !== 'und') language = iso;
    }

    const stsd = (() => {
      const minf = child(moov, mdia[1], mdia[2], 'minf');
      const stbl = minf && child(moov, minf[1], minf[2], 'stbl');
      return stbl && child(moov, stbl[1], stbl[2], 'stsd');
    })();
    const fourcc = stsd && stsd[2] - stsd[1] >= 16 ? ascii(moov, stsd[1] + 12, 4) : '';

    let name = '';
    const udta = child(moov, s, e, 'udta');
    const nameBox = udta && child(moov, udta[1], udta[2], 'name');
    if (nameBox) name = utf8(moov, nameBox[1], nameBox[2] - nameBox[1]);

    if (handler !== 'soun') {
      const codec: SubtitleCodec =
        fourcc === 'tx3g' ? 'mov_text' : fourcc === 'wvtt' ? 'webvtt' : 'other';
      subtitles.push({ index: subtitles.length, language, name, codec, isDefault: false });
      continue;
    }
    const codec = mp4Codec(fourcc);

    const tkhd = child(moov, s, e, 'tkhd');
    const enabled = tkhd ? (moov.getUint32(tkhd[1]) & 1) === 1 : true;
    if (enabled && firstEnabled < 0) firstEnabled = tracks.length;

    tracks.push({ index: tracks.length, language, name, codec, isDefault: false });
  }
  if (tracks.length) tracks[Math.max(0, firstEnabled)].isDefault = true;
  return { audio: tracks, subtitles };
}

// ================================================================ Matroska

const ID = {
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  TrackEntry: 0xae,
  TrackType: 0x83,
  CodecID: 0x86,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  FlagDefault: 0x88,
} as const;

interface Ebml {
  id: number;
  /** -1 for unknown size. */
  size: number;
  dataStart: number;
}

/** Read an element header at `p`; null if it runs off the view. */
function ebmlHeader(view: DataView, p: number): Ebml | null {
  if (p >= view.byteLength) return null;
  const first = view.getUint8(p);
  let idLen = 1;
  while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
  if (idLen > 4 || p + idLen > view.byteLength) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + view.getUint8(p + i);

  const q = p + idLen;
  if (q >= view.byteLength) return null;
  const lead = view.getUint8(q);
  let sizeLen = 1;
  while (sizeLen <= 8 && !(lead & (0x80 >> (sizeLen - 1)))) sizeLen++;
  if (sizeLen > 8 || q + sizeLen > view.byteLength) return null;
  let size = lead & (0xff >> sizeLen);
  let allOnes = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const b = view.getUint8(q + i);
    if (b !== 0xff) allOnes = false;
    size = size * 256 + b;
  }
  return { id, size: allOnes ? -1 : size, dataStart: q + sizeLen };
}

function ebmlUint(view: DataView, start: number, size: number): number {
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + view.getUint8(start + i);
  return n;
}

function mkvSubtitleCodec(id: string): SubtitleCodec {
  if (id === 'S_TEXT/ASS' || id === 'S_TEXT/SSA' || id === 'S_ASS' || id === 'S_SSA') return 'ass';
  if (id === 'S_TEXT/UTF8' || id === 'S_TEXT/ASCII') return 'srt';
  if (id === 'S_TEXT/WEBVTT') return 'webvtt';
  if (id === 'S_HDMV/PGS' || id === 'S_VOBSUB' || id === 'S_DVBSUB') return 'image';
  return 'other';
}

function mkvCodec(id: string): AudioCodec {
  if (id.startsWith('A_AAC')) return 'aac';
  if (id === 'A_MPEG/L3') return 'mp3';
  if (id === 'A_OPUS') return 'opus';
  if (id === 'A_VORBIS') return 'vorbis';
  if (id === 'A_FLAC') return 'flac';
  if (id.startsWith('A_PCM')) return 'pcm';
  if (id === 'A_AC3') return 'ac3';
  if (id === 'A_EAC3') return 'eac3';
  if (id.startsWith('A_DTS')) return 'dts';
  if (id === 'A_TRUEHD' || id === 'A_MLP') return 'truehd';
  return 'other';
}

function parseTracks(view: DataView): ProbedTracks {
  const tracks: ProbedAudioTrack[] = [];
  const subtitles: ProbedSubtitleTrack[] = [];
  let p = 0;
  while (p < view.byteLength) {
    const el = ebmlHeader(view, p);
    if (!el || el.size < 0) break;
    const end = el.dataStart + el.size;
    if (el.id === ID.TrackEntry) {
      let type = 0;
      let codecId = '';
      let name = '';
      let language = 'eng'; // Matroska's default when the element is absent
      let bcp47 = '';
      let isDefault = true; // likewise
      let q = el.dataStart;
      while (q < end) {
        const f = ebmlHeader(view, q);
        if (!f || f.size < 0) break;
        if (f.id === ID.TrackType) type = ebmlUint(view, f.dataStart, f.size);
        else if (f.id === ID.CodecID) codecId = ascii(view, f.dataStart, f.size).replace(/\0+$/, '');
        else if (f.id === ID.Name) name = utf8(view, f.dataStart, f.size);
        else if (f.id === ID.Language) language = ascii(view, f.dataStart, f.size).replace(/\0+$/, '');
        else if (f.id === ID.LanguageBCP47) bcp47 = ascii(view, f.dataStart, f.size).replace(/\0+$/, '');
        else if (f.id === ID.FlagDefault) isDefault = ebmlUint(view, f.dataStart, f.size) === 1;
        q = f.dataStart + f.size;
      }
      if (type === 2) {
        const lang = bcp47 || (language === 'und' ? '' : language);
        tracks.push({ index: tracks.length, language: lang, name, codec: mkvCodec(codecId), isDefault });
      }
      // 17 is Matroska's subtitle track type.
      if (type === 17) {
        const lang = bcp47 || (language === 'und' ? '' : language);
        subtitles.push({
          index: subtitles.length,
          language: lang,
          name,
          codec: mkvSubtitleCodec(codecId),
          isDefault,
        });
      }
    }
    p = end;
  }
  return { audio: tracks, subtitles };
}

async function probeMatroska(file: File): Promise<ProbedTracks> {
  // EBML header, then the Segment.
  const head = await read(file, 0, 4096);
  const ebml = ebmlHeader(head, 0);
  if (!ebml || ebml.size < 0) return NO_TRACKS;
  const seg = ebmlHeader(head, ebml.dataStart + ebml.size);
  if (!seg || seg.id !== ID.Segment) return NO_TRACKS;
  const segmentData = seg.dataStart;

  const readTracksAt = async (pos: number) => {
    const h = ebmlHeader(await read(file, pos, 16), 0);
    if (!h || h.id !== ID.Tracks || h.size < 0 || h.size > MAX_SCAN_BYTES) return null;
    return parseTracks(await read(file, pos + h.dataStart, h.size));
  };

  // Tracks almost always comes before the first Cluster; step over siblings by
  // their headers. If a Cluster comes first, the SeekHead says where Tracks is.
  let p = segmentData;
  let tracksPos = -1;
  while (p < Math.min(file.size, MAX_SCAN_BYTES)) {
    const view = await read(file, p, 16);
    const el = ebmlHeader(view, 0);
    if (!el) break;
    if (el.id === ID.Tracks) return (await readTracksAt(p)) ?? NO_TRACKS;
    if (el.id === ID.SeekHead && el.size > 0 && el.size < 1024 * 1024) {
      const seek = await read(file, p + el.dataStart, el.size);
      let q = 0;
      while (q < seek.byteLength) {
        const s = ebmlHeader(seek, q);
        if (!s || s.size < 0) break;
        if (s.id === ID.Seek) {
          let target = 0;
          let pos = -1;
          let r = s.dataStart;
          while (r < s.dataStart + s.size) {
            const f = ebmlHeader(seek, r);
            if (!f || f.size < 0) break;
            if (f.id === ID.SeekID) target = ebmlUint(seek, f.dataStart, f.size);
            if (f.id === ID.SeekPosition) pos = ebmlUint(seek, f.dataStart, f.size);
            r = f.dataStart + f.size;
          }
          if (target === ID.Tracks && pos >= 0) tracksPos = segmentData + pos;
        }
        q = s.dataStart + s.size;
      }
    }
    if (el.id === ID.Cluster || el.size < 0) break;
    p += el.dataStart + el.size;
  }
  if (tracksPos >= 0) return (await readTracksAt(tracksPos)) ?? NO_TRACKS;
  return NO_TRACKS;
}

// ================================================================ helpers

/** Codecs Chromium plays out of the box. The rest must be converted first. */
export function browserPlays(codec: AudioCodec): boolean {
  return ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm'].includes(codec);
}

const ISO639_2_TO_1: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it',
  por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', ara: 'ar',
  hin: 'hi', urd: 'ur', tur: 'tr', pol: 'pl', dut: 'nl', nld: 'nl', swe: 'sv',
  nor: 'no', dan: 'da', fin: 'fi', gre: 'el', ell: 'el', heb: 'he', tha: 'th',
  vie: 'vi', ind: 'id', msa: 'ms', may: 'ms', per: 'fa', fas: 'fa', ben: 'bn',
  tam: 'ta', tel: 'te', ukr: 'uk', ces: 'cs', cze: 'cs', hun: 'hu', ron: 'ro',
  rum: 'ro',
};

/** "eng" / "en-US" / "en" -> "en"; '' stays ''. */
export function primaryLanguage(tag: string): string {
  const base = tag.toLowerCase().split(/[-_]/)[0] ?? '';
  return ISO639_2_TO_1[base] ?? base;
}
