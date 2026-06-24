/**
 * Phase 31 (web-orchestrator-editor) — orchestrator-tasks route + config logic.
 *
 * Boots the REAL Hono `app` (no DB / no Bun.serve — boot is guarded by
 * `import.meta.main`) to assert the config router is mounted BEHIND the /api/*
 * JWT catch-all (authed user route, not a public webhook). Plus pure-logic
 * assertions for the command set, lifecycle presets, the unique-violation → 409
 * mapping, and that Never/Once are accepted frequency labels.
 *
 * RUN IN ISOLATION (`bun test hub/test/orchestrator-tasks.route.test.ts`) — Bun's
 * mock.module is process-global (see memory: feedback_bun_mock_pollution.md).
 */

// Module-load env so config.ts validation passes (mirrors mount-order.test.ts).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-bb';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';

import { describe, test, expect } from 'bun:test';
import { app } from '../src/index.ts';
import { isKnownCommand, ORCHESTRATOR_COMMANDS } from '../src/orchestrator/command-set.ts';
import { presetRowsForStage } from '../src/orchestrator/stage-presets.ts';
import { isUniqueViolation } from '../src/db/orchestrator-rows-dal.ts';

describe('orchestrator-tasks: mounted behind the /api/* JWT catch-all', () => {
  const paths: Array<[string, string]> = [
    ['GET', '/api/orchestrator-tasks/some-session'],
    ['POST', '/api/orchestrator-tasks/some-session'],
    ['PATCH', '/api/orchestrator-tasks/some-task'],
    ['POST', '/api/orchestrator-tasks/some-task/apply-preset'],
    ['POST', '/api/orchestrator-tasks/some-task/rows'],
    ['PATCH', '/api/orchestrator-tasks/rows/some-row'],
    ['DELETE', '/api/orchestrator-tasks/rows/some-row'],
    ['POST', '/api/orchestrator-tasks/some-task/rows/reorder'],
  ];

  for (const [method, path] of paths) {
    test(`unauth ${method} ${path} → 401 (authed route, not a public webhook, not 404)`, async () => {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      });
      expect(
        res.status,
        `${method} ${path} returned ${res.status}; expected 401. A 404 means the ` +
          `router is unmounted; any 2xx means it ran without auth.`,
      ).toBe(401);
    });
  }
});

describe('orchestrator-tasks: command set (SPEC §3)', () => {
  test('known commands accepted; unknown rejected', () => {
    expect(isKnownCommand('gsd-plan-phase')).toBe(true);
    expect(isKnownCommand('merge-to-main')).toBe(true);
    expect(isKnownCommand('rm-rf-prod')).toBe(false);
    expect(isKnownCommand('micro-prompt')).toBe(false); // micro rows validated separately
  });

  test('command set is exactly the nine user-configurable rows', () => {
    expect([...ORCHESTRATOR_COMMANDS].sort()).toEqual(
      [
        'gap-scan',
        'gsd-audit-fix',
        'gsd-code-review',
        'gsd-complete-milestone',
        'gsd-execute-phase',
        'gsd-plan-phase',
        'gsd-ship',
        'gsd-verify-work',
        'merge-to-main',
      ].sort(),
    );
  });
});

describe('orchestrator-tasks: lifecycle presets + Never/Once', () => {
  test('each stage yields preset rows; unknown falls back to development', () => {
    for (const stage of ['development', 'beta', 'production-maintenance']) {
      expect(presetRowsForStage(stage).length).toBeGreaterThan(0);
    }
    expect(presetRowsForStage('bogus')).toEqual(presetRowsForStage('development'));
  });

  test('presets use Never for parked rows and a cadence label otherwise', () => {
    const dev = presetRowsForStage('development');
    const labels = new Set(dev.map((r) => r.frequency_label));
    // development parks milestone/ship as Never.
    expect(labels.has('Never')).toBe(true);
    // Never rows carry no schedule_rule and are disabled.
    for (const r of dev) {
      if (r.frequency_label === 'Never') {
        expect(r.schedule_rule).toBeNull();
        expect(r.enabled).toBe(false);
      }
    }
  });
});

describe('orchestrator-tasks: unique-violation → 409 mapping', () => {
  test('isUniqueViolation detects Postgres 23505 only', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
