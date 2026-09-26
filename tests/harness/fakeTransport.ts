/**
 * A transport that records what was sent and lets a test post what "arrives".
 *
 * It implements the §10 seam exactly, so the engine cannot tell it from the
 * WebSocket one. `syncedNow` is the fake clock plus an injectable offset: the
 * whole scheduling model rests on both sides agreeing on epoch ms, and a test
 * that wants to prove a command still lands on time under a skewed clock sets
 * the offset rather than reaching into the engine.
 */

import type {
  SyncErrorCode,
  SyncMessage,
  SyncTransport,
  TransportState,
} from '@/lib/sync/types';

export class FakeTransport implements SyncTransport {
  readonly sent: SyncMessage[] = [];

  state: TransportState = 'connected';
  isAuthority: boolean;
  rttMs = 40;
  rttStdDevMs = 5;
  lossRate = 0;
  peerPresent = true;
  peerId: string | null = 'them';
  /** Added to the fake clock, so a test can run a skewed but corrected client. */
  offsetMs = 0;

  private readonly clock: () => number;
  private readonly handlers = new Set<(msg: SyncMessage) => void>();
  private readonly stateHandlers = new Set<(s: TransportState) => void>();
  private readonly presenceHandlers = new Set<(p: boolean, id: string | null) => void>();
  private readonly authorityHandlers = new Set<(a: boolean) => void>();
  private readonly errorHandlers = new Set<(c: SyncErrorCode, m: string) => void>();

  constructor(clock: () => number, opts: { isAuthority?: boolean } = {}) {
    this.clock = clock;
    this.isAuthority = opts.isAuthority ?? false;
  }

  // ---- what a test drives

  /** Deliver a message as if it came off the wire. */
  receive(msg: SyncMessage): void {
    for (const fn of this.handlers) fn(msg);
  }

  setState(state: TransportState): void {
    this.state = state;
    for (const fn of this.stateHandlers) fn(state);
  }

  setAuthority(isAuthority: boolean): void {
    this.isAuthority = isAuthority;
    for (const fn of this.authorityHandlers) fn(isAuthority);
  }

  /** The last message of a type, which is what most assertions want. */
  last<T extends SyncMessage['type']>(type: T): Extract<SyncMessage, { type: T }> | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].type === type) return this.sent[i] as Extract<SyncMessage, { type: T }>;
    }
    return null;
  }

  ofType<T extends SyncMessage['type']>(type: T): Array<Extract<SyncMessage, { type: T }>> {
    return this.sent.filter((m) => m.type === type) as Array<Extract<SyncMessage, { type: T }>>;
  }

  // ---- SyncTransport

  async connect(): Promise<void> {
    this.setState('connected');
  }

  disconnect(): void {
    this.setState('disconnected');
  }

  send(msg: SyncMessage): void {
    this.sent.push(msg);
  }

  on(handler: (msg: SyncMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onPeerPresence(handler: (present: boolean, peerId: string | null) => void): () => void {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  onAuthorityChange(handler: (isAuthority: boolean) => void): () => void {
    this.authorityHandlers.add(handler);
    return () => this.authorityHandlers.delete(handler);
  }

  onError(handler: (code: SyncErrorCode, message: string) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  syncedNow(): number {
    return this.clock() + this.offsetMs;
  }
}
