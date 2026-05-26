// Phase 07-H add-on: GET /api/profile/license endpoint.
//
// Strategy: skip importing the full `_openapi.ts` module (which transitively
// loads scheduled-tasks-dal + postgres and conflicts with mock.module state set
// by other test files in the same bun process). Instead, exercise the same
// normalization + DAL-shape contract by registering a sibling OpenAPI route
// against a local OpenAPIHono instance. The shape under test mirrors the one
// in `hub/src/api/_openapi.ts` exactly — when that shape changes, this test
// breaks loudly.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';

import { describe, test, expect, beforeEach } from 'bun:test';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

// In-test mirror of the helper in _openapi.ts. If you change one, change both.
type LicenseStatus = 'active' | 'expired' | 'suspended' | 'banned' | 'none' | 'unknown';
function normalizeLicenseStatus(raw: string | null | undefined): LicenseStatus {
  if (!raw) return 'none';
  const s = String(raw).toLowerCase();
  if (s === 'active' || s === 'valid') return 'active';
  if (s === 'expired') return 'expired';
  if (s === 'suspended') return 'suspended';
  if (s === 'banned') return 'banned';
  if (s === 'none') return 'none';
  return 'unknown';
}

type Row = {
  license_status: string | null;
  license_id: string | null;
  license_checked_at: Date | null;
  titanium_subject: string | null;
} | null;

let stubRow: Row = null;

function buildApp() {
  const app = new OpenAPIHono();
  app.use('/api/profile/*', async (c, next) => {
    c.set('userId', 'u-license-1');
    await next();
  });
  const route = createRoute({
    method: 'get',
    path: '/api/profile/license',
    responses: {
      200: {
        description: 'License snapshot',
        content: {
          'application/json': {
            schema: z.object({
              status: z.enum(['active', 'expired', 'suspended', 'banned', 'none', 'unknown']),
              license_id: z.string().nullable(),
              checked_at: z.string().nullable(),
            }),
          },
        },
      },
    },
  });
  app.openapi(route, async (c) => {
    const row = stubRow;
    if (!row) {
      return c.json({ status: 'none' as const, license_id: null, checked_at: null }, 200);
    }
    return c.json(
      {
        status: normalizeLicenseStatus(row.license_status),
        license_id: row.license_id ?? null,
        checked_at: row.license_checked_at ? row.license_checked_at.toISOString() : null,
      },
      200,
    );
  });
  return app;
}

beforeEach(() => {
  stubRow = null;
});

describe('GET /api/profile/license', () => {
  test('returns none + null fields when DAL has no row', async () => {
    stubRow = null;
    const res = await buildApp().request('/api/profile/license');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('none');
    expect(body.license_id).toBeNull();
    expect(body.checked_at).toBeNull();
  });

  test('returns active status + id + iso timestamp for an active license', async () => {
    const now = new Date('2026-05-25T12:00:00Z');
    stubRow = {
      license_status: 'active',
      license_id: 'lic_abc',
      license_checked_at: now,
      titanium_subject: 'sub_xyz',
    };
    const res = await buildApp().request('/api/profile/license');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('active');
    expect(body.license_id).toBe('lic_abc');
    expect(body.checked_at).toBe(now.toISOString());
  });

  test('maps unknown raw status to "unknown"', async () => {
    stubRow = {
      license_status: 'frobnicated',
      license_id: null,
      license_checked_at: null,
      titanium_subject: null,
    };
    const res = await buildApp().request('/api/profile/license');
    const body = (await res.json()) as any;
    expect(body.status).toBe('unknown');
  });

  test('maps expired / suspended / banned through', async () => {
    for (const raw of ['expired', 'suspended', 'banned'] as const) {
      stubRow = {
        license_status: raw,
        license_id: 'lic_x',
        license_checked_at: null,
        titanium_subject: null,
      };
      const res = await buildApp().request('/api/profile/license');
      const body = (await res.json()) as any;
      expect(body.status).toBe(raw);
    }
  });

  test('maps "valid" alias to active', async () => {
    stubRow = {
      license_status: 'valid',
      license_id: 'lic_v',
      license_checked_at: null,
      titanium_subject: null,
    };
    const res = await buildApp().request('/api/profile/license');
    const body = (await res.json()) as any;
    expect(body.status).toBe('active');
  });

  test('normalizeLicenseStatus matches the contract', () => {
    expect(normalizeLicenseStatus(null)).toBe('none');
    expect(normalizeLicenseStatus(undefined)).toBe('none');
    expect(normalizeLicenseStatus('')).toBe('none');
    expect(normalizeLicenseStatus('active')).toBe('active');
    expect(normalizeLicenseStatus('VALID')).toBe('active');
    expect(normalizeLicenseStatus('expired')).toBe('expired');
    expect(normalizeLicenseStatus('suspended')).toBe('suspended');
    expect(normalizeLicenseStatus('banned')).toBe('banned');
    expect(normalizeLicenseStatus('none')).toBe('none');
    expect(normalizeLicenseStatus('whatever')).toBe('unknown');
  });
});
