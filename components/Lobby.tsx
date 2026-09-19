'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FileDropZone } from './FileDropZone';
import {
  fingerprintsMatch,
  nameOf,
  randomRoomCode,
  useRuya,
} from '@/lib/store';
import {
  DEFAULT_RELAY_URL,
  applyDevFlagFromUrl,
  getDevServerSnapshot,
  getDevSnapshot,
  getDisplayNameServerSnapshot,
  getDisplayNameSnapshot,
  getRelayUrlServerSnapshot,
  getRelayUrlSnapshot,
  subscribeConfig,
  validateRelayUrl,
} from '@/lib/relayConfig';

/** Room codes never use I, L, O, 0 or 1 — see ROOM_ALPHABET in the store. */
const MISREAD = /[ILO01]/;

interface LobbyError {
  code: string;
  title: string;
  hint: string;
  detail?: string;
}

export function Lobby() {
  const router = useRouter();
  const [draftName, setDraftName] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [localError, setLocalError] = useState<LobbyError | null>(null);

  // localStorage is not available while this page is prerendered, so it is read
  // as an external store rather than in an effect: the server snapshot is the
  // default, and the client swaps to the stored value on hydration without a
  // mismatch or a cascading render.
  const devMode = useSyncExternalStore(
    subscribeConfig,
    getDevSnapshot,
    getDevServerSnapshot,
  );
  const storedRelayUrl = useSyncExternalStore(
    subscribeConfig,
    getRelayUrlSnapshot,
    getRelayUrlServerSnapshot,
  );
  // While the field is being edited the draft wins; until then it tracks
  // whatever is stored, including a change made in another tab.
  const [draftRelayUrl, setDraftRelayUrl] = useState<string | null>(null);
  const relayUrl = draftRelayUrl ?? storedRelayUrl;

  // Same shape for the name: prefilled from the last visit, draft once typed.
  const storedName = useSyncExternalStore(
    subscribeConfig,
    getDisplayNameSnapshot,
    getDisplayNameServerSnapshot,
  );
  const name = draftName ?? storedName;

  const roomCode = useRuya((s) => s.roomCode);
  const startSession = useRuya((s) => s.startSession);
  const sessionError = useRuya((s) => s.sessionError);

  useEffect(() => {
    // Writes to an external system, returns nothing: no setState here.
    applyDevFlagFromUrl();
  }, []);

  const urlCheck = validateRelayUrl(relayUrl, devMode);
  const usingMock = relayUrl.trim() === '' && devMode;
  const canConnect = usingMock || urlCheck.ok;
  const hasName = name.trim().length > 0;

  const begin = async (code: string, isAuthority: boolean) => {
    if (!hasName) return;
    if (!canConnect) {
      // Open the field that needs fixing rather than greying out a button with
      // no reason given.
      setAdvanced(true);
      setLocalError({
        code: 'invalid_url',
        title: 'That relay address will not do.',
        hint: urlCheck.message ?? 'It must begin with wss:// (or ws:// on your own network).',
      });
      return;
    }
    setBusy(true);
    try {
      await startSession({
        roomCode: code,
        displayName: name.trim(),
        isAuthority,
        relayUrl,
      });
    } finally {
      setBusy(false);
    }
  };

  const join = () => {
    if (joinCode.length !== 6) {
      setLocalError({
        code: 'code_short',
        title: 'A code is six characters.',
        hint: 'Codes never contain I, L, O, 0 or 1 — they are meant to be read aloud.',
      });
      return;
    }
    if (MISREAD.test(joinCode)) {
      setLocalError({
        code: 'code_alphabet',
        title: 'No such room.',
        hint: 'Codes never contain I, L, O, 0 or 1. Check the characters you were given.',
      });
      return;
    }
    void begin(joinCode, false);
  };

  if (roomCode) return <Room onEnter={() => router.push(`/room?code=${roomCode}`)} />;

  const shownError: LobbyError | null =
    localError ?? (sessionError ? describeSessionError(sessionError) : null);

  return (
    <main className="grid min-h-screen flex-1 grid-cols-1 min-[720px]:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)] bg-background [animation:ry-in-soft_.7s_ease_both]">
      <section className="flex flex-col justify-between gap-14 border-line px-[clamp(16px,5vw,72px)] py-[clamp(40px,6vw,88px)] min-[720px]:border-r">
        <div>
          <h1 className="mb-[26px] font-display text-[clamp(56px,8vw,104px)] font-light leading-[0.9] tracking-[-0.02em]">
            ruyah
          </h1>
          <div className="mb-7 h-px w-14 origin-left bg-gold [animation:ry-rule_1.1s_.25s_cubic-bezier(.2,.8,.2,1)_both]" />
          <p className="mb-[22px] max-w-[460px] font-display text-[clamp(22px,2.6vw,28px)] font-light italic leading-[1.35]">
            Watch the same film together, each from your own copy.
          </p>
          <p className="max-w-[430px] text-justify text-[14.5px] leading-[1.85] text-muted hyphens-auto">
            Only a trickle of timing messages crosses the network. The film never
            leaves your machine — no upload, no stream, no account. Two players,
            one clock.
          </p>
        </div>
        <dl className="flex max-w-[430px] flex-col gap-[11px] font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
          <Fact term="transport" value="timing messages only" />
          <Fact term="media" value="local file" />
          <Fact term="identity" value="a name you type" last />
        </dl>
      </section>

      <section className="flex flex-col justify-center gap-6 bg-panel px-[clamp(16px,5vw,72px)] py-[clamp(40px,6vw,88px)]">
        <p className="kicker tracking-[0.22em] text-kicker">begin</p>

        <div>
          <label className="kicker mb-[9px] block" htmlFor="name">
            your name
          </label>
          <div className="relative">
            <input
              id="name"
              value={name}
              onChange={(e) => {
                setDraftName(e.target.value);
                setLocalError(null);
              }}
              placeholder=""
              maxLength={24}
              autoComplete="off"
              className="peer w-full border-0 border-b border-line-strong bg-transparent px-0.5 py-[11px] font-display text-[26px] caret-gold-hi outline-none"
            />
            <FadingPlaceholder
              text="Your Beautiful Name"
              hidden={name.length > 0}
              className="px-0.5 py-[11px] font-display text-[26px]"
            />
            {/* Focus draws a gold line across the underline, left to right. */}
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-gold-hi transition-transform duration-500 ease-[cubic-bezier(.2,.8,.2,1)] peer-focus:scale-x-100" />
          </div>
        </div>

        <button
          type="button"
          disabled={!hasName || busy}
          onClick={() => void begin(randomRoomCode(), true)}
          className="cursor-pointer rounded border border-gold bg-transparent px-[22px] py-[17px] text-center font-display text-[19px] font-semibold text-gold-hi transition-[background-color,color,transform,opacity] duration-500 hover:bg-gold/15 hover:text-foreground active:scale-[.985]"
        >
          {busy ? 'Opening the room…' : 'Create a room'}
        </button>

        <div className="my-0.5 flex items-center gap-4">
          <span className="h-px flex-1 bg-line" />
          <span className="font-display text-[17px] italic text-muted">or join a room</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <div className="flex flex-wrap items-end gap-3.5">
          <div className="min-w-0 flex-[1_1_200px]">
            <label className="kicker mb-[9px] block" htmlFor="code">
              room code
            </label>
            <div className="relative">
              <input
                id="code"
                value={joinCode}
                onChange={(e) => {
                  setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
                  setLocalError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hasName && !busy) join();
                }}
                placeholder=""
                maxLength={6}
                autoComplete="off"
                spellCheck={false}
                className="peer w-full border-0 border-b border-line-strong bg-transparent px-0.5 py-[11px] font-mono text-2xl uppercase tracking-[0.22em] caret-gold-hi outline-none"
              />
              <FadingPlaceholder
                text="KXR7MQ"
                hidden={joinCode.length > 0}
                className="px-0.5 py-[11px] font-mono text-2xl uppercase tracking-[0.22em]"
              />
              <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-gold-hi transition-transform duration-500 ease-[cubic-bezier(.2,.8,.2,1)] peer-focus:scale-x-100" />
            </div>
          </div>
          <button
            type="button"
            disabled={!hasName || joinCode.length !== 6 || busy}
            onClick={join}
            className="cursor-pointer rounded border border-line-strong bg-transparent px-[26px] py-[15px] font-display text-base font-semibold transition-[border-color,color,transform,opacity] duration-500 hover:border-gold hover:text-gold-hi active:scale-[.985]"
          >
            Join
          </button>
        </div>

        {shownError && <ErrorCard error={shownError} />}

        <div className="mt-1.5 border-t border-line-soft pt-[18px]">
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            aria-expanded={advanced}
            className="kicker flex cursor-pointer items-center gap-[9px] border-0 bg-transparent p-0 tracking-[0.18em] transition-colors duration-300 hover:text-muted"
          >
            <span
              aria-hidden
              className="inline-block transition-transform duration-400 ease-[cubic-bezier(.2,.8,.2,1)]"
              style={{ transform: `rotate(${advanced ? 90 : 0}deg)` }}
            >
              ›
            </span>
            advanced
          </button>

          {/* Height animates from nothing, so the centred form eases up to make
              room instead of jumping; the contents fade in as it opens. */}
          <AnimatePresence initial={false}>
            {advanced && (
              <motion.div
                key="advanced"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{
                  height: { type: 'spring', stiffness: 300, damping: 34 },
                  opacity: { duration: 0.25 },
                }}
                className="overflow-hidden"
              >
                <div className="pt-[18px]">
                  <label className="kicker mb-[9px] block" htmlFor="relay">
                    relay address
                  </label>
                  <div className="relative">
                    <input
                      id="relay"
                      value={relayUrl}
                      onChange={(e) => {
                        setDraftRelayUrl(e.target.value);
                        setLocalError(null);
                      }}
                      placeholder={DEFAULT_RELAY_URL}
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                      className="peer w-full border-0 border-b border-line bg-transparent px-0.5 py-[9px] font-mono text-[13px] text-muted caret-gold-hi outline-none"
                    />
                    <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-gold-hi transition-transform duration-500 ease-[cubic-bezier(.2,.8,.2,1)] peer-focus:scale-x-100" />
                  </div>
                  <p className="mt-3 text-[12.5px] leading-[1.7] text-faint">
                    Both of you must use the same relay. It only forwards timestamps —
                    it never sees a frame of the film.
                  </p>
                  {!urlCheck.ok && !usingMock && (
                    <p className="mt-2 text-[12.5px] leading-[1.7] text-bad">{urlCheck.message}</p>
                  )}
                  {usingMock && (
                    <p className="mt-2 text-[12.5px] leading-[1.7] text-warn">
                      Dev mode: empty, so this tab talks to other tabs in this browser over the
                      mock transport. No relay is used.
                    </p>
                  )}
                  {relayUrl.trim() !== DEFAULT_RELAY_URL && (
                    <button
                      type="button"
                      onClick={() => setDraftRelayUrl(DEFAULT_RELAY_URL)}
                      className="mt-2 cursor-pointer border-0 border-b border-gold/50 bg-transparent p-0 font-mono text-[11px] text-gold-hi transition-colors duration-300 hover:text-foreground"
                    >
                      Reset to default
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>
    </main>
  );
}

function Fact({ term, value, last }: { term: string; value: string; last?: boolean }) {
  return (
    <div className={`flex justify-between ${last ? '' : 'border-b border-line-soft pb-2'}`}>
      <dt>{term}</dt>
      <dd className="text-muted">{value}</dd>
    </div>
  );
}

/**
 * Four failures, four different things to do about them. Collapsing them into
 * "could not connect" would leave someone retrying a full room forever, or
 * checking their wifi because of a typo.
 */
function describeSessionError({ code, message }: { code: string; message: string }): LobbyError {
  const TITLES: Record<string, string> = {
    room_full: 'That room is full.',
    invalid_url: 'That relay address will not do.',
    unreachable: 'Could not reach the relay.',
    rejected: 'The relay refused the connection.',
    bad_message: 'That room code was refused.',
    rate_limited: 'The relay cut us off.',
  };

  const HINTS: Record<string, string> = {
    room_full: 'Rooms hold two people. Check the code, or start a new room.',
    invalid_url: 'Check the relay address under advanced.',
    unreachable:
      'The relay may be down, or the address may be wrong. Check it under advanced.',
    rejected:
      'Something answered at that address, but it is not a ruyah relay. Check it under advanced.',
    // The alphabet has no I, L, O, 0 or 1 precisely because codes get read
    // aloud — so a refused code is usually one of those misheard.
    bad_message:
      'Room codes are six characters and never contain I, L, O, 0 or 1. Check the code and try again.',
    rate_limited: 'Something is sending far too fast. Reload and try again.',
  };

  return {
    code,
    title: TITLES[code] ?? 'Could not join.',
    hint: HINTS[code] ?? 'Check the relay address under advanced.',
    detail: message,
  };
}

function ErrorCard({ error }: { error: LobbyError }) {
  return (
    <div
      role="alert"
      className="rounded border border-warn/45 px-5 py-[18px] [animation:ry-in_.45s_cubic-bezier(.2,.8,.2,1)_both]"
    >
      <p className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-warn">
        {error.code}
      </p>
      <p className="mb-1.5 font-display text-xl font-semibold">{error.title}</p>
      <p className="text-[13.5px] leading-[1.7] text-muted">{error.hint}</p>
      {error.detail && error.detail !== error.title && (
        <p className="mt-2.5 border-t border-line-soft pt-2.5 font-mono text-[11px] text-faint">
          {error.detail}
        </p>
      )}
    </div>
  );
}

function Room({ onEnter }: { onEnter: () => void }) {
  const [copied, setCopied] = useState(false);
  const roomCode = useRuya((s) => s.roomCode);
  const isAuthority = useRuya((s) => s.isAuthority);
  const peerPresent = useRuya((s) => s.peerPresent);
  const peerReady = useRuya((s) => s.peerReady);
  const peerUserId = useRuya((s) => s.peerUserId);
  const peerFingerprint = useRuya((s) => s.peerFingerprint);
  const fingerprint = useRuya((s) => s.fingerprint);
  const fingerprintStatus = useRuya((s) => s.fingerprintStatus);
  const file = useRuya((s) => s.file);
  const duration = useRuya((s) => s.duration);
  const fileError = useRuya((s) => s.fileError);
  const selfReady = useRuya((s) => s.selfReady);
  const setReady = useRuya((s) => s.setReady);
  const leave = useRuya((s) => s.leave);

  const partner = nameOf(peerUserId);
  const match = fingerprintsMatch(fingerprint, peerFingerprint);
  // §12: duration comes from loadedmetadata, and there is no point being ready
  // without it.
  const canReady = fingerprintStatus === 'ready' && duration > 0 && !fileError;

  useEffect(() => {
    // Client-side navigation, deliberately: it keeps the same document, so the
    // Ready click still counts as the user gesture that unblocks audio (§11).
    if (selfReady && peerReady) onEnter();
  }, [selfReady, peerReady, onEnter]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = () => {
    navigator.clipboard?.writeText(roomCode).then(
      () => setCopied(true),
      () => {
        /* Denied or unavailable: the code is on screen to read aloud anyway. */
      },
    );
  };

  const partnerLine = !peerPresent
    ? 'Waiting for the other person to join…'
    : peerReady
      ? `${partner} is ready.`
      : `${partner} is here, choosing a file.`;
  const partnerDot = !peerPresent ? 'bg-faint' : peerReady ? 'bg-ok' : 'bg-gold-hi';

  const readyLabel = !canReady
    ? "I'm ready"
    : selfReady
      ? peerReady
        ? 'Beginning…'
        : `Ready — waiting for ${partner}`
      : "I'm ready";
  const readyFoot = !canReady
    ? 'Ready unlocks once your file is read'
    : selfReady
      ? 'click again to un-ready'
      : 'playback begins on its own when both of you are ready';

  return (
    <main className="grid min-h-screen flex-1 grid-cols-1 min-[720px]:grid-cols-[minmax(0,3fr)_minmax(360px,2fr)] bg-background [animation:ry-in-soft_.6s_ease_both]">
      <section className="flex flex-col justify-between gap-12 border-line px-[clamp(16px,5vw,66px)] py-[clamp(40px,6vw,80px)] min-[720px]:border-r">
        <div>
          <div className="mb-5 flex flex-wrap items-center gap-3.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-kicker">
              room code
            </span>
            <span className="rounded-sm border border-gold/50 px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.16em] text-gold-hi">
              {isAuthority ? 'hosting' : 'joined · following the host'}
            </span>
          </div>
          <button
            type="button"
            onClick={copy}
            aria-label={`Room code ${roomCode.split('').join(' ')}. Copy to clipboard`}
            className="flex cursor-pointer gap-[0.09em] border-0 bg-transparent p-0 font-mono text-[clamp(46px,7vw,78px)] leading-none tracking-[0.1em] transition-colors duration-300 hover:text-gold-hi"
          >
            {roomCode.split('').map((ch, i) => (
              <span
                key={i}
                className="inline-block [animation:ry-glyph_.5s_cubic-bezier(.2,.8,.2,1)_both]"
                style={{ animationDelay: `${i * 0.07}s` }}
              >
                {ch}
              </span>
            ))}
          </button>
          <p
            className={`mt-4 flex items-center gap-[9px] font-mono text-[10.5px] uppercase tracking-[0.14em] transition-colors duration-300 ${
              copied ? 'text-gold-hi' : 'text-faint'
            }`}
          >
            {/* Lifted to the capitals' middle: centring on the line box sits it
                low, because the line box includes the descender space. */}
            <span
              className={`inline-flex h-2.5 w-2.5 -translate-y-[2px] items-center justify-center rounded-[1px] border transition-colors duration-300 ${
                copied ? 'border-gold-hi' : 'border-faint'
              }`}
            >
              <AnimatePresence>
                {copied && (
                  <motion.svg
                    key="tick"
                    width="8"
                    height="8"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <motion.path
                      d="M1.5 5.2l2.3 2.3L8.5 2.5"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.3, ease: 'easeOut' }}
                    />
                  </motion.svg>
                )}
              </AnimatePresence>
            </span>
            {copied ? 'copied' : 'click to copy'}
          </p>
          <p className="mt-8 max-w-[390px] text-justify text-[14.5px] leading-[1.85] text-muted hyphens-auto">
            {isAuthority
              ? 'Say it aloud, or send it however you normally talk. You are the timing authority until the relay hands it over.'
              : 'You joined this room. The host sets the pace; your player corrects gently toward theirs.'}
          </p>
        </div>
        <button
          type="button"
          onClick={leave}
          className="cursor-pointer self-start border-0 border-b border-line bg-transparent p-0 pb-[3px] font-display text-base text-muted transition-colors duration-300 hover:border-gold hover:text-foreground"
        >
          Leave room
        </button>
      </section>

      <section className="flex flex-col justify-center gap-6 bg-panel px-[clamp(16px,5vw,66px)] py-[clamp(36px,5vw,64px)]">
        <FileDropZone />

        <div
          className={`rounded border px-5 py-[18px] transition-colors duration-600 ${
            peerReady ? 'border-ok/35' : 'border-line'
          }`}
        >
          <div className="flex items-center gap-[13px]">
            <span
              className={`h-2 w-2 flex-none rounded-full transition-colors duration-600 ${partnerDot} ${
                peerPresent && !peerReady ? '[animation:ry-pulse_2s_ease-in-out_infinite]' : ''
              }`}
            />
            <span
              className={`font-display text-lg transition-colors duration-600 ${
                peerPresent ? 'not-italic' : 'italic text-muted'
              } ${peerReady ? 'font-semibold' : ''}`}
            >
              {partnerLine}
            </span>
          </div>
          {peerReady && file && match !== null && (
            <p
              className={`mt-[13px] border-t border-line-soft pt-3 font-mono text-[11px] [animation:ry-in-soft_.6s_ease_both] ${
                match ? 'text-ok' : 'text-warn'
              }`}
            >
              {match
                ? '✓ same encode'
                : '⚠ different encode · timestamps may not line up'}
            </p>
          )}
        </div>

        <button
          type="button"
          disabled={!canReady}
          onClick={() => setReady(!selfReady)}
          className={`cursor-pointer rounded border bg-transparent p-[17px] font-display text-lg font-semibold transition-[background-color,border-color,color,transform] duration-400 hover:bg-gold/15 active:scale-[.99] ${
            selfReady ? 'border-line-strong text-muted' : 'border-gold text-gold-hi'
          }`}
        >
          {readyLabel}
        </button>
        <p className="m-0 text-center font-mono text-[10.5px] text-faint">{readyFoot}</p>
      </section>
    </main>
  );
}

/**
 * A placeholder that leaves instead of vanishing: on the first keystroke its
 * letters drift up and blur away one after another, and they settle back in
 * when the field is emptied. Drawn over the input rather than as the native
 * placeholder, which can only be there or not.
 */
function FadingPlaceholder({
  text,
  hidden,
  className,
}: {
  text: string;
  hidden: boolean;
  className: string;
}) {
  const chars = Array.from(text);
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 top-0 flex overflow-hidden whitespace-pre text-dim ${className}`}
    >
      {chars.map((ch, i) => (
        <motion.span
          key={i}
          className="inline-block"
          initial={false}
          animate={
            hidden
              ? { opacity: 0, y: -10, filter: 'blur(4px)' }
              : { opacity: 1, y: 0, filter: 'blur(0px)' }
          }
          transition={{
            duration: hidden ? 0.32 : 0.4,
            ease: [0.2, 0.8, 0.2, 1],
            // Left to right both ways: the first letter typed lands where the
            // placeholder starts, so it reads as the typing pushing it out.
            delay: i * 0.018,
          }}
        >
          {ch}
        </motion.span>
      ))}
    </span>
  );
}
