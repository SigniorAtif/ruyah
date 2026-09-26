/**
 * Relay validation (server §4). The relay checks shape and nothing else — it
 * must not learn what a position is — so these tests pin the boundary as much
 * as the rules.
 */

import { describe, expect, it } from 'vitest';
import {
  CLOCK_TYPES,
  isValidUserId,
  KNOWN_TYPES,
  MAX_MESSAGE_BYTES,
  MAX_USER_ID_LENGTH,
  parseFrame,
  RELAY_TYPES,
  ROOM_CODE_RE,
} from '../server/protocol.js';

const frame = (obj: unknown) => JSON.stringify(obj);

describe('parseFrame', () => {
  it('accepts every relayed type', () => {
    for (const type of RELAY_TYPES) {
      const result = parseFrame(frame({ type, anything: true }));
      expect(result.ok, type).toBe(true);
    }
  });

  it('accepts a ping with a finite t0 and rejects one without', () => {
    expect(parseFrame(frame({ type: 'ping', t0: 1 })).ok).toBe(true);

    // t0 is echoed back and subtracted from the client's own clock, so a
    // string or a NaN there would silently poison an offset estimate.
    for (const t0 of ['soon', null, undefined, NaN, Infinity]) {
      const result = parseFrame(frame({ type: 'ping', t0 }));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('bad_ping');
    }
  });

  it('rejects anything that is not a JSON object', () => {
    expect(parseFrame('not json').reason).toBe('not_json');
    expect(parseFrame(frame([1, 2, 3])).reason).toBe('not_an_object');
    expect(parseFrame(frame(null)).reason).toBe('not_an_object');
    expect(parseFrame(frame('a string')).reason).toBe('not_an_object');
    expect(parseFrame(frame(7)).reason).toBe('not_an_object');
  });

  it('rejects a missing or non-string type', () => {
    expect(parseFrame(frame({ position: 1 })).reason).toBe('no_type');
    expect(parseFrame(frame({ type: 4 })).reason).toBe('no_type');
  });

  it('rejects a type it does not know', () => {
    // The relay is a whitelist, so a scanner or a future client's message is
    // refused rather than forwarded blind.
    expect(parseFrame(frame({ type: 'shutdown' })).reason).toBe('unknown_type');
    expect(parseFrame(frame({ type: 'PLAY' })).reason).toBe('unknown_type');
  });

  it('rejects a frame over the size cap, at the boundary', () => {
    const fits = frame({ type: 'chat', text: 'x'.repeat(MAX_MESSAGE_BYTES - 200) });
    expect(fits.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseFrame(fits).ok).toBe(true);

    const over = 'x'.repeat(MAX_MESSAGE_BYTES + 1);
    expect(parseFrame(over).reason).toBe('oversize');
    // Checked before parsing, so an oversize frame is never even deserialised.
    expect(parseFrame('['.repeat(MAX_MESSAGE_BYTES + 1)).reason).toBe('oversize');
  });

  it('does not inspect the payload of a message it forwards', () => {
    // §1: if the relay needs to understand a message to relay it, the design
    // has gone wrong. A nonsense position is the client's problem.
    const result = parseFrame(frame({ type: 'seek', position: 'the end', executeAt: 'later' }));
    expect(result.ok).toBe(true);
  });

  it('keeps clock traffic and relayed traffic in separate sets', () => {
    expect([...CLOCK_TYPES].sort()).toEqual(['ping', 'pong']);
    for (const type of CLOCK_TYPES) expect(RELAY_TYPES.has(type)).toBe(false);
    expect(KNOWN_TYPES.size).toBe(CLOCK_TYPES.size + RELAY_TYPES.size);
  });
});

describe('isValidUserId', () => {
  it('accepts an ordinary display name', () => {
    expect(isValidUserId('ruaa')).toBe(true);
    expect(isValidUserId('Ruaa 🌙')).toBe(true);
    expect(isValidUserId('x'.repeat(MAX_USER_ID_LENGTH))).toBe(true);
  });

  it('rejects empty, oversized, or non-string ids', () => {
    expect(isValidUserId('')).toBe(false);
    expect(isValidUserId('x'.repeat(MAX_USER_ID_LENGTH + 1))).toBe(false);
    expect(isValidUserId(undefined)).toBe(false);
    expect(isValidUserId(42)).toBe(false);
  });

  it('rejects control characters, which would corrupt a log line', () => {
    expect(isValidUserId('two\nlines')).toBe(false);
    expect(isValidUserId('null\u0000byte')).toBe(false);
    expect(isValidUserId('bell\u0007')).toBe(false);
  });
});

describe('room codes', () => {
  it('accepts six characters from the unambiguous alphabet', () => {
    expect(ROOM_CODE_RE.test('H48UBD')).toBe(true);
    expect(ROOM_CODE_RE.test('ABCDEF')).toBe(true);
  });

  it('rejects the characters that get misread aloud', () => {
    // No O/0, no I/1/L — the code exists to be read out to someone.
    for (const bad of ['HELLO0', 'ABCDEI', 'ABCD1F', 'ABCDLF']) {
      expect(ROOM_CODE_RE.test(bad), bad).toBe(false);
    }
  });

  it('rejects the wrong length or case', () => {
    expect(ROOM_CODE_RE.test('ABCDE')).toBe(false);
    expect(ROOM_CODE_RE.test('ABCDEFG')).toBe(false);
    expect(ROOM_CODE_RE.test('abcdef')).toBe(false);
    expect(ROOM_CODE_RE.test('')).toBe(false);
  });
});
