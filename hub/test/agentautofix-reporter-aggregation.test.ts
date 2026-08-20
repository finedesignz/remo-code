// Findings 2 & 3: a 45s per-fingerprint aggregation window coalesces a burst
// of same-fingerprint errors into one outbound report (additive to the
// existing hourly throttle), and a noise filter drops known-benign
// server-side classes (AbortError, ECONNRESET) before anything is scheduled.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  reportSelfErrorToAgentautofix,
  _flushPendingForTest,
  _resetForTest,
} from '../src/agentautofix/reporter';

const { config } = (await import('../src/config')) as any;
const originalAgentautofix = { ...config.agentautofix };

const originalFetch = globalThis.fetch;
let calls: Array<{ body: any }> = [];

beforeEach(() => {
  config.agentautofix = {
    configured: true,
    host: 'https://agentautofix.titaniumlabs.us',
    appId: 'app_test',
    publicKey: 'pk_test',
    signingSecret: 'signing-secret-at-least-32-chars-long-x',
    origin: 'https://app.remo-code.com',
  };
  calls = [];
  // @ts-expect-error test stub
  globalThis.fetch = async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  _resetForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.agentautofix = { ...originalAgentautofix };
  _resetForTest();
});

describe('reportSelfErrorToAgentautofix aggregation', () => {
  test('a burst of the same fingerprint coalesces into one network call', async () => {
    const fields = { fingerprint: 'fp-1', errorType: 'Error', errorValue: 'boom', source: 'hono' };
    await reportSelfErrorToAgentautofix(fields);
    await reportSelfErrorToAgentautofix(fields);
    await reportSelfErrorToAgentautofix(fields);
    expect(calls.length).toBe(0); // nothing sent synchronously — still in the window

    _flushPendingForTest('fp-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.length).toBe(1);
    expect(calls[0].body.element_meta.occurrences).toBe(3);
    expect(calls[0].body.comment).toContain('x3');
  });

  test('a single occurrence reports without an occurrence-count suffix', async () => {
    const fields = { fingerprint: 'fp-single', errorType: 'Error', errorValue: 'boom', source: 'hono' };
    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-single');
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.length).toBe(1);
    expect(calls[0].body.element_meta.occurrences).toBe(1);
    expect(calls[0].body.comment).not.toContain(' (x');
  });

  test('distinct fingerprints aggregate independently', async () => {
    await reportSelfErrorToAgentautofix({ fingerprint: 'fp-a', errorType: 'Error', errorValue: 'a', source: 'hono' });
    await reportSelfErrorToAgentautofix({ fingerprint: 'fp-b', errorType: 'Error', errorValue: 'b', source: 'hono' });
    _flushPendingForTest('fp-a');
    _flushPendingForTest('fp-b');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(2);
  });
});

describe('reportSelfErrorToAgentautofix noise filter', () => {
  test('drops AbortError before scheduling', async () => {
    await reportSelfErrorToAgentautofix({ fingerprint: 'fp-abort', errorType: 'AbortError', errorValue: 'The operation was aborted', source: 'hono' });
    _flushPendingForTest('fp-abort');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0);
  });

  test('drops ECONNRESET before scheduling', async () => {
    await reportSelfErrorToAgentautofix({ fingerprint: 'fp-econnreset', errorType: 'Error', errorValue: 'read ECONNRESET', source: 'hono' });
    _flushPendingForTest('fp-econnreset');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0);
  });

  test('a normal error still schedules and sends', async () => {
    await reportSelfErrorToAgentautofix({ fingerprint: 'fp-real', errorType: 'TypeError', errorValue: 'x is not a function', source: 'hono' });
    _flushPendingForTest('fp-real');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
  });
});
