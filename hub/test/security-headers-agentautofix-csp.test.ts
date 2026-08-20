// Finding 4: connect-src must allow the AgentAutofix host explicitly (only
// when config.agentautofix.configured), and a malformed host string must
// never be able to inject extra CSP directives via `;` or `,`.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';

import { describe, test, expect, afterEach } from 'bun:test';
import { securityHeaders, DEFAULT_CSP, agentautofixConnectSrcEntry } from '../src/middleware/security-headers';

// The exported `config` is a plain mutable object (see titanium-client.test.ts
// precedent) — mutate `agentautofix` in place rather than registering a new
// process-global mock.module that would shadow other tests' fields.
const { config } = await import('../src/config') as any;
const originalAgentautofix = { ...config.agentautofix };

afterEach(() => {
  config.agentautofix = { ...originalAgentautofix };
});

async function renderedCsp(): Promise<string> {
  const { Hono } = await import('hono');
  const app = new Hono();
  app.use('*', securityHeaders());
  app.get('/ok', (c) => c.text('ok'));
  const res = await app.request('/ok');
  return res.headers.get('Content-Security-Policy') || '';
}

describe('agentautofix CSP wiring (finding 4)', () => {
  test('never adds the host when agentautofix is not configured', async () => {
    config.agentautofix = { ...originalAgentautofix, configured: false, host: 'https://agentautofix.titaniumlabs.us' };
    expect(agentautofixConnectSrcEntry()).toBeNull();
    const value = await renderedCsp();
    expect(value).not.toContain('agentautofix.titaniumlabs.us');
  });

  test('adds the host to connect-src when configured with a valid origin', async () => {
    config.agentautofix = { ...originalAgentautofix, configured: true, host: 'https://agentautofix.titaniumlabs.us' };
    expect(agentautofixConnectSrcEntry()).toBe('https://agentautofix.titaniumlabs.us');
    const value = await renderedCsp();
    const connectSrc = value.split(';').find((p) => p.trim().startsWith('connect-src'))!;
    expect(connectSrc).toContain('agentautofix.titaniumlabs.us');
    // Existing entries must survive, not be replaced.
    for (const existing of DEFAULT_CSP.connectSrc) expect(connectSrc).toContain(existing);
  });

  test('rejects a host containing a semicolon (directive-injection attempt)', () => {
    config.agentautofix = { ...originalAgentautofix, configured: true, host: 'https://evil.example; script-src *' };
    expect(agentautofixConnectSrcEntry()).toBeNull();
  });

  test('rejects a host containing a comma', () => {
    config.agentautofix = { ...originalAgentautofix, configured: true, host: 'https://a.example,https://b.example' };
    expect(agentautofixConnectSrcEntry()).toBeNull();
  });

  test('rejects a host containing whitespace', () => {
    config.agentautofix = { ...originalAgentautofix, configured: true, host: 'https://evil.example \'unsafe-eval\'' };
    expect(agentautofixConnectSrcEntry()).toBeNull();
  });

  test('rejects an empty host even when marked configured', () => {
    config.agentautofix = { ...originalAgentautofix, configured: true, host: '' };
    expect(agentautofixConnectSrcEntry()).toBeNull();
  });
});
