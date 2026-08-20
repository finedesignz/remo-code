// Finding 5: bare hex runs (git SHAs, raw hex request ids) with no `0x`
// prefix previously survived normalization untouched, so otherwise-identical
// errors fingerprinted differently and defeated the hourly throttle. Collapse
// requires length >= 8 AND at least one actual hex LETTER (a-f) so ordinary
// hex-letter English words ("decade", "facade", "added") are never
// over-collapsed.
//
// Regression (defect A, this PR): the original fix used "at least one digit"
// as the hex-vs-word guard. `[0-9a-f]` is a superset of `[0-9]`, and every
// decimal number trivially contains a digit, so any 8+ digit PURE DECIMAL
// run (epoch-ms timestamps, byte counts, plain numeric ids) was also
// collapsing to 'HEX' — conflating two genuinely different errors into one
// fingerprint and silently defeating the hourly throttle. Fixed by requiring
// an actual hex letter [a-f] in the matched run instead of any digit.
import { describe, expect, test } from 'bun:test';
import { normalize, fingerprint } from '../src/error-capture/fingerprint';

describe('normalize bare hex collapse', () => {
  test('collapses a 40-char git SHA', () => {
    expect(normalize('at commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe('at commit HEX');
  });

  test('collapses a raw hex request id', () => {
    expect(normalize('request 9f8e7d6c failed')).toBe('request HEX failed');
  });

  test('does not collapse ordinary hex-letter English words', () => {
    expect(normalize('a facade over a decade of added complexity')).toBe(
      'a facade over a decade of added complexity',
    );
  });

  test('does not collapse short hex-looking tokens under the length floor', () => {
    expect(normalize('id abc123')).toBe('id abc123');
  });

  test('still collapses 0x-prefixed hex via the existing rule', () => {
    expect(normalize('addr 0xdeadbeef')).toBe('addr HEX');
  });

  test('does not collapse a pure decimal run of 8+ digits (defect A regression)', () => {
    expect(normalize('user 12345678 order failed')).toBe('user 12345678 order failed');
  });

  test('does not collapse a 13-digit epoch-ms timestamp (defect A regression)', () => {
    expect(normalize('event at 1755638400123 recorded')).toBe('event at 1755638400123 recorded');
  });

  test('a real 40-char git SHA (has letters) still collapses (no regression from defect A fix)', () => {
    expect(normalize('deadbeefcafe0123456789abcdef0123456789a')).toBe('HEX');
  });

  test('still collapses UUIDs via the existing rule (no regression from defect A fix)', () => {
    expect(normalize('id 123e4567-e89b-12d3-a456-426614174000 failed')).toBe('id UUID failed');
  });
});

describe('fingerprint throttle defeat repro (finding 5)', () => {
  test('two errors differing only by a bare hex SHA now fingerprint identically', () => {
    const a = fingerprint('proj', 'Error', 'build failed at a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    const b = fingerprint('proj', 'Error', 'build failed at aabbccddeeff00112233445566778899aabbccdd');
    expect(a).toBe(b);
  });
});

describe('fingerprint distinctness for pure-decimal runs (defect A regression)', () => {
  test('two distinct 8+ digit pure-decimal error messages produce DIFFERENT fingerprints', () => {
    const a = fingerprint('proj', 'Error', 'user 12345678 order failed');
    const b = fingerprint('proj', 'Error', 'user 87654321 order failed');
    expect(a).not.toBe(b);
  });
});
