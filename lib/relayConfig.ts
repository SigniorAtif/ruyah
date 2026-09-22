'use client';

/**
 * Relay endpoint configuration — runtime, never build time.
 *
 * The frontend is a static bundle: the same files must work against any relay,
 * chosen when the page is open rather than when it was compiled. So there is no
 * `process.env.*` anywhere in this file and nothing here is inlined at build.
 * The endpoint comes from the person using the app, falls back to
 * DEFAULT_RELAY_URL, and is remembered in localStorage.
 */

/**
 * The relay offered by default.
 *
 * Deployment (server spec §6) has not chosen a hostname yet — that section is
 * still marked DECISION NEEDED — so this is a placeholder. It is a plain
 * constant rather than an env var on purpose: changing it is a code change with
 * a diff, and anyone can override it in the UI without a rebuild.
 */
export const DEFAULT_RELAY_URL = 'wss://your-relay.example.com/ws';

const RELAY_URL_KEY = 'ruyah:relay-url';
const DEV_FLAG_KEY = 'ruyah:dev';
const DISPLAY_NAME_KEY = 'ruyah:display-name';
const LAST_ROOM_KEY = 'ruyah:last-room';

/**
 * Failure reasons the lobby can explain (Phase 2 §3 plus the connection-level
 * ones the browser gives us).
 */
export type RelayUrlError = 'empty' | 'unparseable' | 'insecure' | 'wrong_scheme';

export interface RelayUrlCheck {
  ok: boolean;
  url: string;
  error?: RelayUrlError;
  message?: string;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode or storage disabled. The field still works, it just will not
    // be remembered — which is a preference, not a failure.
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* as above */
  }
}

/**
 * This module is a tiny external store, read through useSyncExternalStore.
 *
 * It has to be: the values live in localStorage, which does not exist while the
 * page is prerendered. Reading it in an effect and calling setState would cause
 * a cascading render (and React's lint rule says so); reading it during render
 * would produce a hydration mismatch. The server snapshot below is the honest
 * answer for "what did the prerendered HTML say", and the client swaps to the
 * stored value after hydration.
 */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeConfig(onChange: () => void): () => void {
  listeners.add(onChange);
  // 'storage' fires for OTHER tabs, which is exactly when this can change
  // behind our back — someone editing the relay in a second tab.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * Dev mode.
 *
 * Runtime, not `NODE_ENV`: a static export bakes NODE_ENV in at build, which is
 * exactly the build-time coupling this module exists to remove. Set it by
 * visiting the app once with `?dev=1`; it sticks until cleared with `?dev=0`.
 * It allows a loopback relay in any build; the dev tools themselves exist only
 * in builds that carry them (lib/devTools.d.ts).
 */
export function isDevMode(): boolean {
  if (typeof window === 'undefined') return false;
  return safeGet(DEV_FLAG_KEY) === '1';
}

export const getDevSnapshot = isDevMode;
export const getDevServerSnapshot = (): boolean => false;

/**
 * Reads `?dev=1` / `?dev=0` off the URL and persists it.
 *
 * Writing to an external system from an effect is the supported pattern; this
 * deliberately returns nothing, so no caller is tempted to feed it to setState.
 */
export function applyDevFlagFromUrl(): void {
  if (typeof window === 'undefined') return;
  const param = new URLSearchParams(window.location.search).get('dev');
  const next = param === '1' ? '1' : param === '0' ? '0' : null;
  if (next === null) return;
  if (safeGet(DEV_FLAG_KEY) === next) return; // no change, no re-render
  safeSet(DEV_FLAG_KEY, next);
  emit();
}

export function loadRelayUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_RELAY_URL;
  const stored = safeGet(RELAY_URL_KEY);
  // An empty stored value is meaningful in dev mode — it selects the mock — so
  // only a missing key falls back to the default.
  return stored === null ? DEFAULT_RELAY_URL : stored;
}

export const getRelayUrlSnapshot = loadRelayUrl;
export const getRelayUrlServerSnapshot = (): string => DEFAULT_RELAY_URL;

export function saveRelayUrl(url: string): void {
  if (typeof window === 'undefined') return;
  const next = url.trim();
  if (safeGet(RELAY_URL_KEY) === next) return;
  safeSet(RELAY_URL_KEY, next);
  emit();
}

/**
 * The name last used to enter a room, so the lobby can offer it again instead
 * of asking every visit. Shares this store (and its cross-tab 'storage'
 * subscription) with the relay URL: both are "who and where I was last time".
 */
export function loadDisplayName(): string {
  if (typeof window === 'undefined') return '';
  return safeGet(DISPLAY_NAME_KEY) ?? '';
}

export const getDisplayNameSnapshot = loadDisplayName;
export const getDisplayNameServerSnapshot = (): string => '';

export function saveDisplayName(name: string): void {
  if (typeof window === 'undefined') return;
  const next = name.trim();
  if (next === '' || safeGet(DISPLAY_NAME_KEY) === next) return;
  safeSet(DISPLAY_NAME_KEY, next);
  emit();
}

/**
 * The room last entered, so the lobby can offer to go back after a refresh, a
 * crash or a closed tab. The userId comes along so the relay gives back the
 * same seat, and with it the authority if it was ours (§3).
 */
export interface LastRoom {
  code: string;
  relayUrl: string;
  displayName: string;
  userId: string;
  /** Epoch ms when it was entered. */
  at: number;
}

/** Past this, a room is not worth offering: the other person has long gone to bed. */
export const LAST_ROOM_TTL_MS = 6 * 60 * 60 * 1000;

/** The stored text, not the parsed object, so an unchanged value is the same snapshot. */
export function getLastRoomSnapshot(): string | null {
  if (typeof window === 'undefined') return null;
  return safeGet(LAST_ROOM_KEY);
}

export const getLastRoomServerSnapshot = (): string | null => null;

export function parseLastRoom(raw: string | null): LastRoom | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<LastRoom>;
    if (
      typeof r.code !== 'string' ||
      typeof r.relayUrl !== 'string' ||
      typeof r.displayName !== 'string' ||
      typeof r.userId !== 'string' ||
      typeof r.at !== 'number'
    ) {
      return null;
    }
    return r as LastRoom;
  } catch {
    return null;
  }
}

export function saveLastRoom(room: LastRoom): void {
  if (typeof window === 'undefined') return;
  safeSet(LAST_ROOM_KEY, JSON.stringify(room));
  emit();
}

export function clearLastRoom(): void {
  if (typeof window === 'undefined' || safeGet(LAST_ROOM_KEY) === null) return;
  try {
    localStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* as in safeSet */
  }
  emit();
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Validate a relay endpoint.
 *
 * `wss://` only. The reason is not stylistic: the page is served over HTTPS and
 * browsers refuse a `ws://` socket from a secure page outright — it fails with
 * no useful error and no log line, which is the single most confusing way for
 * this to break (server spec §6 says the same about TLS).
 *
 * The one exception is a loopback relay in dev mode. Browsers treat
 * http://localhost as a secure context, so `ws://localhost:8080/ws` genuinely
 * works there, and it is the only way to test against a real relay on one
 * machine. It is gated behind the dev flag so it can never apply in production.
 */
export function validateRelayUrl(raw: string, devMode = isDevMode()): RelayUrlCheck {
  const url = raw.trim();

  if (url === '') {
    return {
      ok: false,
      url,
      error: 'empty',
      message:
        __RUYAH_DEV_TOOLS__ && devMode
          ? 'Empty uses the built-in mock transport (dev mode).'
          : 'Enter the address of a relay to connect to.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      url,
      error: 'unparseable',
      message: `That is not a valid address. It should look like ${DEFAULT_RELAY_URL}`,
    };
  }

  if (parsed.protocol === 'wss:') return { ok: true, url };

  if (parsed.protocol === 'ws:') {
    if (devMode && isLoopback(parsed.hostname)) return { ok: true, url };
    return {
      ok: false,
      url,
      error: 'insecure',
      message:
        'Must be wss://. This page is served over HTTPS, and browsers block a ' +
        'plain ws:// socket from a secure page — it fails silently, with no ' +
        'error you could act on. Put the relay behind TLS and use wss://.',
    };
  }

  return {
    ok: false,
    url,
    error: 'wrong_scheme',
    message: `A relay address starts with wss://, not ${parsed.protocol}//`,
  };
}
