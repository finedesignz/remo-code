// Finding 5: bare hex runs (git SHAs, raw hex request ids) with no `0x`
// prefix previously survived normalization untouched, so otherwise-identical
// errors fingerprinted differently and defeated the hourly throttle. Collapse
// requires length >= 8 AND at least one digit so ordinary hex-letter English
// words ("decade", "facade", "added") are never over-collapsed.
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
});

describe('fingerprint throttle defeat repro (finding 5)', () => {
  test('two errors differing only by a bare hex SHA now fingerprint identically', () => {
    const a = fingerprint('proj', 'Error', 'build failed at a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    const b = fingerprint('proj', 'Error', 'build failed at 1122334455667788990011223344556677889900');
    expect(a).toBe(b);
  });
});
