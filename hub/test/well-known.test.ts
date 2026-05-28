// Phase 12.1: public .well-known/* routes (AASA + Android assetlinks).
//
// Both endpoints:
//   - return 200
//   - content-type application/json
//   - body is valid JSON

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.MOBILE_APPLE_TEAM_ID = 'ABCDE12345';
process.env.MOBILE_ANDROID_SHA256_FINGERPRINT = 'AA:BB:CC:DD:EE:FF';
process.env.MOBILE_BUNDLE_ID = 'com.finedesignz.remo-code';

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';

const { wellKnown } = await import('../src/api/well-known');

function buildApp() {
  const app = new Hono();
  app.route('/.well-known', wellKnown);
  return app;
}

describe('GET /.well-known/apple-app-site-association', () => {
  test('returns 200 + application/json + parseable AASA body', async () => {
    const res = await buildApp().request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as any;
    expect(body.applinks).toBeDefined();
    expect(Array.isArray(body.applinks.details)).toBe(true);
    expect(body.applinks.details[0].appID).toBe('ABCDE12345.com.finedesignz.remo-code');
  });
});

describe('GET /.well-known/assetlinks.json', () => {
  test('returns 200 + application/json + parseable assetlinks body', async () => {
    const res = await buildApp().request('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].target.namespace).toBe('android_app');
    expect(body[0].target.package_name).toBe('com.finedesignz.remo-code');
    expect(body[0].target.sha256_cert_fingerprints).toContain('AA:BB:CC:DD:EE:FF');
  });
});
