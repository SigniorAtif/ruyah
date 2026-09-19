/**
 * Every reaction the expanded picker offers, and so every one a peer's
 * reaction is allowed to show. The quick row in the store is drawn from these
 * too; anything not in here is dropped on arrival, which keeps a reaction
 * frame from being a way to paint arbitrary text over someone's film.
 *
 * Single code points (or a single VS16 heart) on purpose: no ZWJ sequences or
 * skin tones, which render as several glyphs on older systems.
 */
export const ALL_EMOJI = [
  // faces
  '😂', '🤣', '😭', '🥺', '🥹', '😍', '🥰', '😘', '😊', '😁',
  '😅', '😆', '🙂', '😉', '😌', '😏', '😳', '😱', '😨', '😰',
  '😮', '😯', '😲', '🤯', '😬', '🫣', '🫢', '🤭', '🤔', '🧐',
  '🤨', '😐', '😑', '🙄', '😒', '😤', '😡', '🤬', '😢', '😞',
  '😔', '🥲', '😴', '🥱', '🤤', '😋', '😎', '🤩', '🥳', '🤪',
  '😈', '💀', '👻', '🤡', '🫠', '🥴', '🤢', '🤮', '🫦', '👀',
  // hearts
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💕',
  '💞', '💓', '💗', '💖', '💘', '💝',
  // hands
  '👏', '🙌', '👍', '👎', '🙏', '🤝', '👋', '🤞', '✌️', '🤌',
  '🫶', '💪', '🫡',
  // things
  '🔥', '✨', '💯', '🎉', '🍿', '🥤', '🍕', '🌹', '💐', '⭐',
  '🌙', '☕', '🎬', '🎵', '💤', '💥', '💫', '🚨', '⚡', '🏆',
] as const;

const ALLOWED: ReadonlySet<string> = new Set(ALL_EMOJI);

export function isKnownEmoji(text: string): boolean {
  return ALLOWED.has(text);
}

/**
 * The most copies one held reaction may put on screen. The picker grows the
 * emoji toward this and the receiver clamps to it, so a peer on a newer build
 * with a bigger limit still cannot flood the other screen.
 */
export const MAX_BURST = 12;

export function clampBurst(count: unknown): number {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.round(count) : 1;
  return Math.min(MAX_BURST, Math.max(1, n));
}
