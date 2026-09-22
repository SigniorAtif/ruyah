import type { ReactionMoment } from './store';

/** One stretch of the film with something in it. */
export interface MomentBin {
  index: number;
  /** Earliest thing that happened in it, seconds: where a jump lands. */
  first: number;
  /** Emoji by copies sent, most first. */
  emoji: Array<[emoji: string, copies: number]>;
  /** Copies of every reaction together; a burst of twelve counts twelve. */
  copies: number;
  /** Chat lines said in it. */
  lines: number;
}

/**
 * Split the film into `bins` equal stretches and gather what was sent in each:
 * reactions from both people, and chat lines by the moment they were about.
 * Empty stretches are left out.
 */
export function binMoments(
  moments: readonly ReactionMoment[],
  linePositions: readonly number[],
  duration: number,
  bins: number,
): MomentBin[] {
  if (!(duration > 0) || bins < 1) return [];
  const at = (position: number) =>
    Math.min(bins - 1, Math.max(0, Math.floor((position / duration) * bins)));
  const out = new Map<number, { first: number; emoji: Map<string, number>; copies: number; lines: number }>();
  const binFor = (i: number, position: number) => {
    let b = out.get(i);
    if (!b) out.set(i, (b = { first: position, emoji: new Map(), copies: 0, lines: 0 }));
    b.first = Math.min(b.first, position);
    return b;
  };
  for (const m of moments) {
    if (!(m.position >= 0) || m.position > duration) continue;
    const b = binFor(at(m.position), m.position);
    b.emoji.set(m.emoji, (b.emoji.get(m.emoji) ?? 0) + m.count);
    b.copies += m.count;
  }
  for (const p of linePositions) {
    if (!(p >= 0) || p > duration) continue;
    binFor(at(p), p).lines++;
  }
  return [...out]
    .sort(([a], [b]) => a - b)
    .map(([index, b]) => ({
      index,
      first: b.first,
      emoji: [...b.emoji].sort((x, y) => y[1] - x[1]),
      copies: b.copies,
      lines: b.lines,
    }));
}
