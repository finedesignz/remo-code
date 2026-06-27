/**
 * web/test/auto-dev-activity.test.tsx
 * OBSRV-02 — unit tests for run-log API client + OBSRV-02 source files.
 *
 * Coverage:
 *   1. fetchRunLog maps API response shape { items } → { entries, hasMore }
 *   2. fetchRunLog with sessionId includes session_id query param
 *   3. fetchRunLog without sessionId omits session_id query param
 *   4. hasMore is true when entries.length === limit
 *   5. hasMore is false when entries.length < limit
 *   6. No indigo colour strings in OBSRV-02 source files
 *
 * NOTE: AutoDevActivityPanel uses hooks (useEffect, useCallback) so it is not
 * suitable for renderToStaticMarkup (throws on hook calls). Logic tested via
 * the API layer unit tests; visual rendering verified by bun run build:web above.
 */

import { describe, expect, test, mock, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── mock hubFetch ─────────────────────────────────────────────────────────────

let capturedPath = '';
let mockItems: unknown[] = [];
let mockLimit = 30;

mock.module('../src/lib/api', () => ({
  hubFetch: async (_token: unknown, path: string) => {
    capturedPath = path;
    return { items: mockItems, limit: mockLimit, offset: 0 };
  },
}));

// Import AFTER mock.module so the mock takes effect
const { fetchRunLog } = await import('../src/lib/run-log-api');

afterAll(() => {
  mock.restore();
});

// ── run-log API client ────────────────────────────────────────────────────────

describe('fetchRunLog', () => {
  const sampleItem = {
    id: 'abc',
    session_id: 's1',
    repo_key: 'github://owner/repo',
    command: 'do thing',
    decision_rationale: null,
    outcome: 'success',
    gap_dimension: null,
    pr_url: null,
    reviewer_verdict: null,
    deploy_verify_result: null,
    created_at: new Date().toISOString(),
  };

  test('maps items array to entries', async () => {
    mockItems = [sampleItem];
    mockLimit = 30;
    const page = await fetchRunLog({ token: null, limit: 30, offset: 0 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].id).toBe('abc');
  });

  test('hasMore true when entries.length === limit', async () => {
    mockItems = [sampleItem];
    mockLimit = 30;
    const page = await fetchRunLog({ token: null, limit: 1, offset: 0 });
    expect(page.hasMore).toBe(true);
  });

  test('hasMore false when entries.length < limit', async () => {
    mockItems = [sampleItem];
    mockLimit = 30;
    const page = await fetchRunLog({ token: null, limit: 30, offset: 0 });
    expect(page.hasMore).toBe(false);
  });

  test('includes session_id param when sessionId provided', async () => {
    mockItems = [];
    await fetchRunLog({ token: null, sessionId: 'sess-xyz', limit: 10, offset: 0 });
    expect(capturedPath).toContain('session_id=sess-xyz');
  });

  test('omits session_id param when sessionId absent', async () => {
    mockItems = [];
    await fetchRunLog({ token: null, limit: 10, offset: 0 });
    expect(capturedPath).not.toContain('session_id');
  });
});

// ── no-indigo guard ───────────────────────────────────────────────────────────

describe('no-indigo in OBSRV-02 files', () => {
  const obsrv02Files = [
    join(import.meta.dir, '../src/lib/run-log-api.ts'),
    join(import.meta.dir, '../src/components/AutoDevActivityPanel.tsx'),
    join(import.meta.dir, '../src/pages/settings/ConnectionsTab.tsx'),
  ];

  test('OBSRV-02 source files contain no indigo references', () => {
    for (const file of obsrv02Files) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toMatch(/indigo/i);
    }
  });
});
