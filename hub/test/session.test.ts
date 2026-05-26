// Phase 07-C: cookie-parser + (when DB available) session lifecycle.
// The cookie parser is pure and tested unconditionally.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';process.env.TITANIUM_ACCOUNT_ID = process.env.TITANIUM_ACCOUNT_ID || 'acct_test_0000000000';process.env.TITANIUM_PRODUCT_ID = process.env.TITANIUM_PRODUCT_ID || 'prod_test_remo';
if (process.env.REMO_E2E_DB_URL) process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL;

import { describe, test, expect } from 'bun:test';
import {
  parseSessionCookieFromHeader,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MS,
  SESSION_TTL_SECONDS,
} from '../src/session';

describe('parseSessionCookieFromHeader', () => {
  test('extracts __Host-remo_sid value', () => {
    const v = parseSessionCookieFromHeader(`${SESSION_COOKIE_NAME}=remo_abc123; other=x`);
    expect(v).toBe('remo_abc123');
  });

  test('returns null when cookie absent', () => {
    expect(parseSessionCookieFromHeader('other=x; foo=bar')).toBeNull();
  });

  test('returns null when header missing', () => {
    expect(parseSessionCookieFromHeader(null)).toBeNull();
    expect(parseSessionCookieFromHeader(undefined)).toBeNull();
    expect(parseSessionCookieFromHeader('')).toBeNull();
  });

  test('decodes percent-encoded value', () => {
    const v = parseSessionCookieFromHeader(`${SESSION_COOKIE_NAME}=remo_a%2Bb%2Fc`);
    expect(v).toBe('remo_a+b/c');
  });

  test('handles cookie at end of header', () => {
    const v = parseSessionCookieFromHeader(`x=1; ${SESSION_COOKIE_NAME}=remo_tail`);
    expect(v).toBe('remo_tail');
  });
});

describe('session constants', () => {
  test('idle window is 60 minutes', () => {
    expect(SESSION_IDLE_MS).toBe(60 * 60 * 1000);
  });
  test('absolute TTL is 7 days', () => {
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
