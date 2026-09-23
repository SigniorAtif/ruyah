/**
 * Stickers, which travel as an ordinary chat line.
 *
 * A sticker is sent as the text `:sticker/grin:` and nothing else, so the wire
 * format and the relay are untouched: to anything that does not know about
 * stickers — an older build on the other side, a log — it is just a short line
 * of text. Only an id in the table below is drawn; anything else stays the
 * text it arrived as, which is why a peer on a newer build with more stickers
 * cannot put an arbitrary image on this screen.
 */
export interface Sticker {
  id: string;
  /** Read out to screen readers, and the fallback if the file is missing. */
  label: string;
  /** Words the picker finds it by. */
  words: string;
  src: string;
}

export const STICKERS: readonly Sticker[] = [
  { id: 'grump', label: 'grumpy bat cat', words: 'grump cat annoyed bat unimpressed', src: '/stickers/grump.png' },
  { id: 'grin', label: 'grinning bat', words: 'grin smile happy bat teeth', src: '/stickers/grin.png' },
  { id: 'sulk', label: 'sulking bat', words: 'sulk sad pout cry bat', src: '/stickers/sulk.png' },
  { id: 'batgirl', label: 'batgirl', words: 'batgirl shy smile bat', src: '/stickers/batgirl.png' },
  { id: 'blush', label: 'blushing bat cat', words: 'blush shy cape bat cat flustered', src: '/stickers/blush.png' },
  { id: 'spidey', label: 'spider-man', words: 'spider man spidey web', src: '/stickers/spidey.png' },
];

const BY_ID = new Map(STICKERS.map((s) => [s.id, s]));

/** The line sent for a sticker. Deliberately readable where it is not drawn. */
export function stickerToken(id: string): string {
  return `:sticker/${id}:`;
}

const TOKEN = /^:sticker\/([a-z0-9-]{1,24}):$/;

/** The sticker a line *is*, or null if it is an ordinary line. */
export function parseSticker(text: string): Sticker | null {
  const match = TOKEN.exec(text.trim());
  return match ? (BY_ID.get(match[1]) ?? null) : null;
}

/** Stickers whose words start with every word of `query`, in picker order. */
export function searchStickers(query: string): Sticker[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...STICKERS];
  return STICKERS.filter((s) => {
    const words = `${s.words} ${s.label}`.split(/\s+/);
    return terms.every((t) => words.some((w) => w.startsWith(t)));
  });
}
