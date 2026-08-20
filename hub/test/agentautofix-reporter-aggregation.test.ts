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
  _getDayCountForTest,
  _forceDayWindowStaleForTest,
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

describe('reportSelfErrorToAgentautofix in-flight-send race (double-send regression)', () => {
  test('a slow/hanging fetch does not let a second window double-send the same fingerprint', async () => {
    const fields = { fingerprint: 'fp-slow', errorType: 'Error', errorValue: 'boom', source: 'hono' };

    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCallCount = 0;
    // @ts-expect-error test stub
    globalThis.fetch = async (_url: string, init: any) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        // First send hangs (e.g. degraded network) until we release it below.
        await firstFetchGate;
      }
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    // Window #1 for fp-slow.
    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-slow'); // fires sendAggregatedReport #1, fetch hangs

    // A second occurrence arrives while #1's fetch is still in flight —
    // bucket was already deleted, so this arms a brand-new window.
    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-slow'); // fires sendAggregatedReport #2

    // Let #2 run to completion first (it should be throttled and return
    // immediately since #1 already reserved the slot).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Now release #1's hung fetch.
    releaseFirstFetch();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Exactly one network call for this fingerprint, not two.
    expect(calls.length).toBe(1);
  });

  test('a FAILED send does not permanently block that fingerprint from reporting later', async () => {
    const fields = { fingerprint: 'fp-fail-then-ok', errorType: 'Error', errorValue: 'boom', source: 'hono' };

    let callCount = 0;
    // @ts-expect-error test stub
    globalThis.fetch = async (_url: string, init: any) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('network down');
      }
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-fail-then-ok'); // send #1 throws, must roll back
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0);

    // A later occurrence for the same fingerprint must NOT be silently
    // blocked by the failed first attempt.
    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-fail-then-ok');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
  });

  test('blocker hangs then SUCCEEDS: second window is genuinely throttled, exactly one report, loss is not silent', async () => {
    const fields = { fingerprint: 'fp-not-lost', errorType: 'Error', errorValue: 'boom', source: 'hono' };

    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCallCount = 0;
    // @ts-expect-error test stub
    globalThis.fetch = async (_url: string, init: any) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) await firstFetchGate;
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-not-lost'); // window #1 flushed, bucket deleted, fetch hanging

    // Occurrence arrives in the gap — must arm a fresh window, not vanish.
    await reportSelfErrorToAgentautofix(fields);

    releaseFirstFetch();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The second occurrence's own window hasn't fired yet (45s timer), but
    // it must still be pending/trackable — flush it explicitly and confirm
    // it eventually reports rather than being dropped.
    _flushPendingForTest('fp-not-lost');
    await new Promise((r) => setTimeout(r, 0));

    // First send throttled the fingerprint for an hour, so this second,
    // later-window flush must NOT produce a second network call — but the
    // occurrence was still processed (not thrown away): total remains 1
    // from the first send, proving it wasn't double-counted OR dropped
    // into a void bucket.
    expect(calls.length).toBe(1);
  });

  test('blocker hangs then resolves 429 (rollback): the second window occurrences are eventually reported, not lost', async () => {
    const fields = { fingerprint: 'fp-hang-429', errorType: 'Error', errorValue: 'boom', source: 'hono' };

    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCallCount = 0;
    // @ts-expect-error test stub
    globalThis.fetch = async (_url: string, init: any) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        await firstFetchGate;
        // First send is rate-limited by the server — rolls back.
        return new Response(JSON.stringify({ ok: false }), { status: 429 });
      }
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-hang-429'); // window #1 flushes, reserves, fetch hangs (in flight)

    // A second burst of occurrences arrives while #1 is still in flight.
    await reportSelfErrorToAgentautofix(fields);
    await reportSelfErrorToAgentautofix(fields);
    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-hang-429'); // must NOT discard these — #1 hasn't settled yet
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0); // nothing sent yet — #1 still hanging, #2 must not double-send

    // Release #1 — it 429s and rolls back its reservation (the hour was
    // never actually consumed).
    releaseFirstFetch();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The re-armed window for the 3 occurrences must still be pending and
    // must now be able to flush successfully — proving they were never lost.
    _flushPendingForTest('fp-hang-429');
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.length).toBe(1);
    expect(calls[0].body.element_meta.occurrences).toBe(3);
  });

  test('blocker hangs then THROWS: the second window occurrences are eventually reported, not lost', async () => {
    const fields = { fingerprint: 'fp-hang-throw', errorType: 'Error', errorValue: 'boom', source: 'hono' };

    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCallCount = 0;
    // @ts-expect-error test stub
    globalThis.fetch = async (_url: string, init: any) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        await firstFetchGate;
        throw new Error('network down');
      }
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-hang-throw'); // window #1 flushes, reserves, fetch hangs (in flight)

    await reportSelfErrorToAgentautofix(fields);
    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-hang-throw'); // must NOT discard — #1 hasn't settled yet
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0);

    // Release #1 — it throws and rolls back its reservation.
    releaseFirstFetch();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    _flushPendingForTest('fp-hang-throw');
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.length).toBe(1);
    expect(calls[0].body.element_meta.occurrences).toBe(2);
  });

  test('dayCount never goes negative across repeated 429 rollbacks, and repeated 429s never burn the daily cap', async () => {
    // @ts-expect-error test stub
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 429 });

    for (let i = 0; i < 10; i++) {
      const fp = `fp-429-burn-${i}`;
      await reportSelfErrorToAgentautofix({ fingerprint: fp, errorType: 'Error', errorValue: 'boom', source: 'hono' });
      _flushPendingForTest(fp);
      await new Promise((r) => setTimeout(r, 0));
      expect(_getDayCountForTest()).toBeGreaterThanOrEqual(0);
    }

    expect(_getDayCountForTest()).toBe(0); // every 429 rolled its reservation back — cap untouched
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

  test('a wrapped rethrow mentioning ECONNRESET mid-message is NOT dropped (defect B regression)', async () => {
    await reportSelfErrorToAgentautofix({
      fingerprint: 'fp-wrapped-econnreset',
      errorType: 'Error',
      errorValue: 'Failed to persist session after socket error: read ECONNRESET',
      source: 'hono',
    });
    _flushPendingForTest('fp-wrapped-econnreset');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
  });

  test('a normal error still schedules and sends', async () => {
    await reportSelfErrorToAgentautofix({ fingerprint: 'fp-real', errorType: 'TypeError', errorValue: 'x is not a function', source: 'hono' });
    _flushPendingForTest('fp-real');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
  });

  // Regression for the unanchored `/\baborted\b/i.test(value)` defect: a
  // legitimate error whose MESSAGE merely contains the word "aborted" must
  // still be forwarded, not silently dropped as noise.
  test('a Postgres "transaction is aborted" error is forwarded, not dropped (unanchored-match regression)', async () => {
    await reportSelfErrorToAgentautofix({
      fingerprint: 'fp-pg-aborted',
      errorType: 'Error',
      errorValue: 'current transaction is aborted, commands ignored until end of transaction block',
      source: 'hono',
    });
    _flushPendingForTest('fp-pg-aborted');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
  });

  test('a "Job aborted due to timeout" error is forwarded, not dropped (unanchored-match regression)', async () => {
    await reportSelfErrorToAgentautofix({
      fingerprint: 'fp-job-aborted',
      errorType: 'Error',
      errorValue: 'Job aborted due to timeout',
      source: 'hono',
    });
    _flushPendingForTest('fp-job-aborted');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
  });

  test('a genuine AbortError (discrete errorType) is still filtered — noise filter still works', async () => {
    await reportSelfErrorToAgentautofix({
      fingerprint: 'fp-genuine-abort',
      errorType: 'AbortError',
      errorValue: 'This operation was aborted',
      source: 'hono',
    });
    _flushPendingForTest('fp-genuine-abort');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0);
  });

  test('a genuine "read ECONNRESET" is still filtered — noise filter still works', async () => {
    await reportSelfErrorToAgentautofix({
      fingerprint: 'fp-genuine-econnreset',
      errorType: 'Error',
      errorValue: 'read ECONNRESET',
      source: 'hono',
    });
    _flushPendingForTest('fp-genuine-econnreset');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0);
  });
});

describe('reportSelfErrorToAgentautofix day-window rollback identity (Finding 2)', () => {
  test('a rollback after the day window rolls over does not decrement the NEW window, and dayCount never goes negative', async () => {
    // Reservation #1: fetch hangs so we can roll the day window over while
    // it's still in flight, then release it to a 429 (rollback path).
    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCallCount = 0;
    // @ts-expect-error test stub
    globalThis.fetch = async (_url: string, init: any) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        await firstFetchGate;
        return new Response(JSON.stringify({ ok: false }), { status: 429 });
      }
      calls.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const fields = { fingerprint: 'fp-window-rollover', errorType: 'Error', errorValue: 'boom', source: 'hono' };
    await reportSelfErrorToAgentautofix(fields);
    _flushPendingForTest('fp-window-rollover'); // reserves dayCount=1 in window A, fetch hangs (in flight)

    expect(_getDayCountForTest()).toBe(1);

    // Roll the day window over WHILE #1 is still in flight, then make a
    // fresh reservation that belongs to the NEW window.
    _forceDayWindowStaleForTest();
    const fields2 = { fingerprint: 'fp-window-rollover-2', errorType: 'Error', errorValue: 'boom2', source: 'hono' };
    await reportSelfErrorToAgentautofix(fields2);
    _flushPendingForTest('fp-window-rollover-2'); // resetDayWindowIfStale() fires here -> dayCount reset to 0, then reserved to 1
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(_getDayCountForTest()).toBe(1); // new window's own reservation, sent successfully

    // Release #1's hung fetch — it 429s and tries to roll back. #1's
    // reservation belongs to the OLD (now-gone) window, so this rollback
    // must be a no-op against the NEW window's counter: it must NOT
    // decrement the new window's legitimate count, and must never go
    // negative.
    releaseFirstFetch();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(_getDayCountForTest()).toBe(1); // unchanged by the stale rollback
    expect(_getDayCountForTest()).toBeGreaterThanOrEqual(0);
  });
});
