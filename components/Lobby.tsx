'use client';

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
  getRelayUrlServerSnapshot,
  getRelayUrlSnapshot,
  subscribeConfig,
  validateRelayUrl,
} from '@/lib/relayConfig';

export function Lobby() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);

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

  const roomCode = useRuya((s) => s.roomCode);
  const startSession = useRuya((s) => s.startSession);
  const sessionError = useRuya((s) => s.sessionError);

  useEffect(() => {
    // Writes to an external system, returns nothing: no setState here.
    applyDevFlagFromUrl();
  }, []);

  const urlCheck = validateRelayUrl(relayUrl, devMode);
  const canConnect = urlCheck.ok;

  const begin = async (code: string, isAuthority: boolean) => {
    if (!name.trim() || !canConnect) return;
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

  if (roomCode) return <Room onEnter={() => router.push(`/room?code=${roomCode}`)} />;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <h1 className="text-lg tracking-wide">ruyah</h1>
      <p className="mt-1 text-sm text-muted">
        Watch the same film together, each from your own copy. Only a trickle of
        timing messages crosses the network.
      </p>

      <label className="mt-10 block text-xs text-muted" htmlFor="name">
        Your name
      </label>
      <input
        id="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Who are you?"
        className="mt-1.5 w-full rounded border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-muted"
      />

      <button
        type="button"
        disabled={!name.trim() || busy || !canConnect}
        onClick={() => void begin(randomRoomCode(), true)}
        className="mt-6 w-full rounded bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-30"
      >
        Create a room
      </button>

      <div className="my-6 flex items-center gap-3 text-[11px] text-muted">
        <span className="h-px flex-1 bg-line" />
        or join hers
        <span className="h-px flex-1 bg-line" />
      </div>

      <div className="flex gap-2">
        <input
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, 6))}
          placeholder="ROOM CODE"
          className="w-full rounded border border-line bg-panel px-3 py-2 font-mono text-sm tracking-[0.2em] outline-none focus:border-muted"
        />
        <button
          type="button"
          disabled={joinCode.length !== 6 || !name.trim() || busy || !canConnect}
          onClick={() => void begin(joinCode, false)}
          className="shrink-0 rounded border border-line px-4 text-sm disabled:opacity-30"
        >
          Join
        </button>
      </div>

      {sessionError && <ConnectionError code={sessionError.code} message={sessionError.message} />}

      <div className="mt-8 border-t border-line pt-4">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="flex w-full items-center justify-between text-[11px] text-muted hover:text-foreground"
          aria-expanded={advanced}
        >
          <span>Advanced</span>
          <span aria-hidden>{advanced ? '−' : '+'}</span>
        </button>

        {advanced && (
          <div className="mt-3">
            <label className="block text-xs text-muted" htmlFor="relay">
              Relay address
            </label>
            <input
              id="relay"
              value={relayUrl}
              onChange={(e) => setDraftRelayUrl(e.target.value)}
              placeholder={DEFAULT_RELAY_URL}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="mt-1.5 w-full rounded border border-line bg-panel px-3 py-2 font-mono text-xs outline-none focus:border-muted"
            />
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Both of you must use the same relay. It only ever sees timing
              messages — never the film.
            </p>
            {!urlCheck.ok && (
              <p className="mt-2 text-[11px] leading-relaxed text-bad">{urlCheck.message}</p>
            )}
            {relayUrl.trim() !== DEFAULT_RELAY_URL && (
              <button
                type="button"
                onClick={() => setDraftRelayUrl(DEFAULT_RELAY_URL)}
                className="mt-2 text-[11px] text-muted underline-offset-2 hover:underline"
              >
                Reset to default
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * Four failures, four different things to do about them. Collapsing them into
 * "could not connect" would leave someone retrying a full room forever, or
 * checking their wifi because of a typo.
 */
function ConnectionError({ code, message }: { code: string; message: string }) {
  const TITLES: Record<string, string> = {
    room_full: 'That room is full',
    invalid_url: 'That relay address is not usable',
    unreachable: 'Could not reach the relay',
    rejected: 'The relay refused the connection',
    bad_message: 'That room code was refused',
    rate_limited: 'The relay cut us off',
  };

  const HINTS: Record<string, string> = {
    room_full: 'Rooms hold two people. Check the code, or start a new room.',
    invalid_url: 'Check the relay address under Advanced.',
    unreachable:
      'The relay may be down, or the address may be wrong. Check it under Advanced.',
    rejected:
      'Something answered at that address, but it is not a ruyah relay. Check it under Advanced.',
    // The alphabet has no I, L, O, 0 or 1 precisely because codes get read
    // aloud — so a refused code is usually one of those misheard.
    bad_message:
      'Room codes are six characters and never contain I, L, O, 0 or 1. Check the code and try again.',
    rate_limited: 'Something is sending far too fast. Reload and try again.',
  };

  const title = TITLES[code] ?? 'Could not join';
  const hint = HINTS[code] ?? 'Check the relay address under Advanced.';

  return (
    <div className="mt-6 rounded border border-bad/40 bg-panel px-3 py-3 text-xs">
      <p className="text-bad">{title}</p>
      <p className="mt-1.5 leading-relaxed text-muted">{message}</p>
      <p className="mt-1.5 leading-relaxed text-muted">{hint}</p>
    </div>
  );
}

function Room({ onEnter }: { onEnter: () => void }) {
  const roomCode = useRuya((s) => s.roomCode);
  const isAuthority = useRuya((s) => s.isAuthority);
  const peerPresent = useRuya((s) => s.peerPresent);
  const peerReady = useRuya((s) => s.peerReady);
  const peerUserId = useRuya((s) => s.peerUserId);
  const peerFingerprint = useRuya((s) => s.peerFingerprint);
  const fingerprint = useRuya((s) => s.fingerprint);
  const fingerprintStatus = useRuya((s) => s.fingerprintStatus);
  const duration = useRuya((s) => s.duration);
  const fileError = useRuya((s) => s.fileError);
  const selfReady = useRuya((s) => s.selfReady);
  const setReady = useRuya((s) => s.setReady);
  const leave = useRuya((s) => s.leave);

  const match = fingerprintsMatch(fingerprint, peerFingerprint);
  // §12: duration comes from loadedmetadata, and there is no point being ready
  // without it.
  const canReady = fingerprintStatus === 'ready' && duration > 0 && !fileError;

  useEffect(() => {
    // Client-side navigation, deliberately: it keeps the same document, so the
    // Ready click still counts as the user gesture that unblocks audio (§11).
    if (selfReady && peerReady) onEnter();
  }, [selfReady, peerReady, onEnter]);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-xs text-muted">Room code</p>
          <p className="font-mono text-2xl tracking-[0.3em]">{roomCode}</p>
        </div>
        {isAuthority && <span className="text-[11px] text-muted">hosting</span>}
      </div>

      <div className="mt-8">
        <FileDropZone />
      </div>

      <div className="mt-8 rounded border border-line bg-panel px-3 py-3 text-xs">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${peerPresent ? 'bg-ok' : 'bg-muted'}`}
          />
          <span>
            {peerPresent
              ? `${nameOf(peerUserId)} is here`
              : 'Waiting for the other person to join…'}
          </span>
        </div>

        {peerReady && (
          <div className="mt-2 space-y-1 border-t border-line pt-2 text-muted">
            <p>{nameOf(peerUserId)} is ready.</p>
            {match === true && <p className="text-ok">Same encode ✓</p>}
            {match === false && (
              <p className="text-warn">
                ⚠ Different encode. Timestamps may not line up — the offset
                slider in the player fixes a fixed difference like an extra
                intro.
              </p>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={!canReady}
        onClick={() => setReady(!selfReady)}
        className={`mt-6 w-full rounded px-3 py-2 text-sm font-medium disabled:opacity-30 ${
          selfReady
            ? 'border border-line text-muted'
            : 'bg-foreground text-background'
        }`}
      >
        {selfReady ? 'Ready — waiting for her' : "I'm ready"}
      </button>

      <button
        type="button"
        onClick={leave}
        className="mt-3 text-[11px] text-muted underline-offset-2 hover:underline"
      >
        Leave room
      </button>
    </main>
  );
}
