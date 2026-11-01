import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildClientWsData } from '../src/ws/client'
import { SESSION_COOKIE_NAME } from '../src/session'

// Regression: after Titanium login the REST cookie auth worked but /ws/client
// closed 4001 immediately, because index.ts spread createClientWsData() AFTER
// cookieToken/csrfCookie, resetting both to null.
describe('/ws/client upgrade data carries the session cookie', () => {
  const header = `${SESSION_COOKIE_NAME}=tok%2Babc_123; csrf_token=csrf%2Bxyz; other=1`

  test('cookieToken and csrfCookie survive the defaults', () => {
    const d = buildClientWsData(header)
    expect(d.cookieToken).toBe('tok+abc_123')
    expect(d.csrfCookie).toBe('csrf+xyz')
    expect(d.authenticated).toBe(false)
    expect(d.authMethod).toBeNull()
  })

  test('no cookie header => nulls (auth then fails closed with 4001)', () => {
    const d = buildClientWsData(null)
    expect(d.cookieToken).toBeNull()
    expect(d.csrfCookie).toBeNull()
  })

  test('index.ts builds /ws/client data via buildClientWsData (no trailing default spread)', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(src).toContain("...buildClientWsData(req.headers.get('cookie'))")
    expect(src).not.toMatch(/cookieToken, csrfCookie, \.\.\.createClientWsData\(\)/)
  })
})
