// Regression guard: `pullRepo`/`cloneRepo` MUST NOT pass GitHub PATs as argv
// (they are world-readable on Windows via WMI/Process Explorer). The fix
// extracts the token via splitTokenFromUrl + hands it to git via GIT_ASKPASS.
//
// Per supervisor audit 2026-05-28: "Token leaked through pullRepo argv".

import { describe, test, expect } from 'bun:test'
import { splitTokenFromUrl } from '../src/git-ops'

describe('splitTokenFromUrl', () => {
  test('extracts a PAT-only userinfo', () => {
    const r = splitTokenFromUrl('https://ghp_abc123@github.com/owner/repo.git')
    expect(r.url).toBe('https://github.com/owner/repo.git')
    expect(r.token).toBe('ghp_abc123')
  })

  test('extracts password from user:token userinfo (token is password)', () => {
    const r = splitTokenFromUrl('https://x-access-token:ghp_xyz@github.com/owner/repo.git')
    expect(r.url).toBe('https://github.com/owner/repo.git')
    expect(r.token).toBe('ghp_xyz')
  })

  test('passes through a URL with no credentials', () => {
    const r = splitTokenFromUrl('https://github.com/owner/repo.git')
    expect(r.url).toBe('https://github.com/owner/repo.git')
    expect(r.token).toBeNull()
  })

  test('http (not just https) is recognized', () => {
    const r = splitTokenFromUrl('http://tok@example.com/x')
    expect(r.url).toBe('http://example.com/x')
    expect(r.token).toBe('tok')
  })
})
