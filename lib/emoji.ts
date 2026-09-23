/**
 * Every reaction the expanded picker offers, and so every one a peer's
 * reaction is allowed to show. The quick row in the store is drawn from these
 * too; anything not in here is dropped on arrival, which keeps a reaction
 * frame from being a way to paint arbitrary text over someone's film.
 *
 * Single code points (or a single VS16 heart) on purpose: no ZWJ sequences or
 * skin tones, which render as several glyphs on older systems.
 */
export interface EmojiGroup {
  id: string;
  label: string;
  /** Each emoji with the words it is found by in the picker's search. */
  emoji: ReadonlyArray<readonly [emoji: string, words: string]>;
}

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    id: 'faces',
    label: 'faces',
    emoji: [
      ['😂', 'laugh joy tears lol funny'],
      ['🤣', 'rofl laugh rolling funny'],
      ['😭', 'cry sob sad tears'],
      ['🥺', 'pleading puppy please'],
      ['🥹', 'holding back tears touched'],
      ['😍', 'heart eyes love'],
      ['🥰', 'love hearts adore'],
      ['😘', 'kiss blow'],
      ['😊', 'smile blush happy'],
      ['😁', 'grin happy'],
      ['😅', 'sweat nervous laugh'],
      ['😆', 'laugh squint'],
      ['🙂', 'smile slight'],
      ['😉', 'wink'],
      ['😌', 'relieved calm'],
      ['😏', 'smirk'],
      ['😳', 'flushed shocked embarrassed'],
      ['😱', 'scream fear shock'],
      ['😨', 'fearful scared'],
      ['😰', 'anxious sweat scared'],
      ['😮', 'wow surprised open mouth'],
      ['😯', 'hushed surprised'],
      ['😲', 'astonished shocked'],
      ['🤯', 'mind blown exploding'],
      ['😬', 'grimace awkward'],
      ['🫣', 'peek scared hide'],
      ['🫢', 'gasp hand over mouth'],
      ['🤭', 'giggle oops'],
      ['🤔', 'thinking hmm'],
      ['🧐', 'monocle inspect'],
      ['🤨', 'raised eyebrow suspicious'],
      ['😐', 'neutral meh'],
      ['😑', 'expressionless unamused'],
      ['🙄', 'eye roll'],
      ['😒', 'unamused side eye'],
      ['😤', 'huff triumph angry'],
      ['😡', 'angry mad rage'],
      ['🤬', 'swearing cursing rage'],
      ['😢', 'cry sad tear'],
      ['😞', 'disappointed sad'],
      ['😔', 'pensive sad'],
      ['🥲', 'smile tear bittersweet'],
      ['😴', 'sleep tired zzz'],
      ['🥱', 'yawn bored tired'],
      ['🤤', 'drool'],
      ['😋', 'yum tasty'],
      ['😎', 'cool sunglasses'],
      ['🤩', 'star struck amazed'],
      ['🥳', 'party celebrate'],
      ['🤪', 'zany crazy silly'],
      ['😈', 'devil evil smirk'],
      ['💀', 'skull dead dying lol'],
      ['👻', 'ghost boo spooky'],
      ['🤡', 'clown'],
      ['🫠', 'melting'],
      ['🥴', 'woozy drunk dizzy'],
      ['🤢', 'nauseated sick gross'],
      ['🤮', 'vomit sick gross'],
      ['🫦', 'lip bite'],
      ['👀', 'eyes look watching'],
    ],
  },
  {
    id: 'hearts',
    label: 'hearts',
    emoji: [
      ['❤️', 'red heart love'],
      ['🧡', 'orange heart'],
      ['💛', 'yellow heart'],
      ['💚', 'green heart'],
      ['💙', 'blue heart'],
      ['💜', 'purple heart'],
      ['🖤', 'black heart'],
      ['🤍', 'white heart'],
      ['💔', 'broken heart sad'],
      ['💕', 'two hearts love'],
      ['💞', 'revolving hearts'],
      ['💓', 'beating heart'],
      ['💗', 'growing heart'],
      ['💖', 'sparkling heart'],
      ['💘', 'heart arrow cupid'],
      ['💝', 'heart ribbon gift'],
    ],
  },
  {
    id: 'hands',
    label: 'hands',
    emoji: [
      ['👏', 'clap applause'],
      ['🙌', 'raised hands celebrate yay'],
      ['👍', 'thumbs up yes like'],
      ['👎', 'thumbs down no dislike'],
      ['🙏', 'pray please thanks'],
      ['🤝', 'handshake deal'],
      ['👋', 'wave hi bye'],
      ['🤞', 'fingers crossed luck'],
      ['✌️', 'peace victory'],
      ['🤌', 'pinched fingers italian'],
      ['🫶', 'heart hands love'],
      ['💪', 'flex strong muscle'],
      ['🫡', 'salute'],
    ],
  },
  {
    id: 'things',
    label: 'things',
    emoji: [
      ['🔥', 'fire hot lit'],
      ['✨', 'sparkles magic'],
      ['💯', 'hundred perfect'],
      ['🎉', 'party tada celebrate'],
      ['🍿', 'popcorn movie'],
      ['🥤', 'drink soda cup'],
      ['🍕', 'pizza food'],
      ['🌹', 'rose flower'],
      ['💐', 'bouquet flowers'],
      ['⭐', 'star'],
      ['🌙', 'moon night'],
      ['☕', 'coffee tea'],
      ['🎬', 'clapper film movie'],
      ['🎵', 'music note song'],
      ['💤', 'zzz sleep'],
      ['💥', 'boom collision explosion'],
      ['💫', 'dizzy stars'],
      ['🚨', 'siren alert'],
      ['⚡', 'lightning zap'],
      ['🏆', 'trophy win'],
    ],
  },
];

export const ALL_EMOJI: readonly string[] = EMOJI_GROUPS.flatMap((g) => g.emoji.map(([e]) => e));

/** Emoji whose words start with every word of `query`, in picker order. */
export function searchEmoji(query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...ALL_EMOJI];
  return EMOJI_GROUPS.flatMap((g) =>
    g.emoji
      .filter(([, words]) => {
        const ws = words.split(' ');
        return terms.every((t) => ws.some((w) => w.startsWith(t)));
      })
      .map(([e]) => e),
  );
}

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
