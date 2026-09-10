// fix/supervisor-hostname-required — canary: the supervisor must ALWAYS put a
// non-empty hostname on its /ws/agent auth frames, including on RE-auth after a
// reconnect (the suspected ghost-session source). A hostname-less frame makes
// the hub record `status='online', hostname=NULL` with a live phantom channel.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { resolveHostname, __resetHostnameCacheForTests } from '../src/hostname'

const SRC = join(import.meta.dir, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')
// The auth OBJECT literal (`type: 'auth',`) — not the type-union member
// (`type: 'auth';`) that declares its shape.
const authFrameOf = (src: string, len = 900) => {
  const i = src.indexOf("type: 'auth',")
  expect(i).toBeGreaterThan(-1)
  return src.slice(i, i + len)
}

describe('supervisor hostname on auth', () => {
  it('resolveHostname() returns a non-empty host identity', () => {
    __resetHostnameCacheForTests()
    expect(resolveHostname().length).toBeGreaterThan(0)
  })

  it('falls back to COMPUTERNAME/HOSTNAME rather than sending an empty hostname', () => {
    __resetHostnameCacheForTests()
    // Even if os.hostname() were to fail, the env chain must yield something on
    // any real host; assert the resolver never returns whitespace-only.
    const h = resolveHostname()
    expect(h).toBe(h.trim())
    expect(h).not.toBe('')
  })

  it('memoizes — a transient OS failure on reconnect cannot blank the hostname', () => {
    __resetHostnameCacheForTests()
    const first = resolveHostname()
    expect(resolveHostname()).toBe(first)
  })

  // Both /ws/agent clients (supervisor socket + per-session bridge) build their
  // auth frame inside `ws.onopen`, i.e. on every reconnect. Guard the call site.
  it('hub-client auth frame uses resolveHostname()', () => {
    expect(authFrameOf(read('hub-client.ts'), 400)).toContain('hostname: resolveHostname()')
  })

  it('session-bridge auth frame + agent_info use resolveHostname()', () => {
    const head = authFrameOf(read('runners/session-bridge.ts'))
    expect(head).toContain('hostname: resolveHostname()')
    // agent_info.hostname too — the hub falls back to it when the top-level
    // field is missing, so it must never be the empty one.
    expect(head.match(/hostname: resolveHostname\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('no /ws/agent auth frame calls the raw os hostname()', () => {
    for (const f of ['hub-client.ts', 'runners/session-bridge.ts']) {
      expect(/hostname:\s*hostname\(\)/.test(authFrameOf(read(f)))).toBe(false)
    }
  })
})
