// fix/supervisor-hostname-required — the hub must not silently accept a
// hostname-less /ws/agent auth (it mints a hostname-NULL ghost session).
import { describe, expect, it } from 'bun:test'
import { AgentInbound } from '../src/ws/agent-protocol'
import { isHostnameRequiredOnAgentAuth } from '../src/ws/agent'

describe('agent auth hostname contract', () => {
  it('accepts an auth frame carrying a hostname', () => {
    const parsed = AgentInbound.safeParse({
      type: 'auth', api_key: 'k', project_dir: 'C:/x', hostname: 'TitaniumTower',
    })
    expect(parsed.success).toBe(true)
  })

  it('still parses a hostname-less frame (compat window) so the hub can close it with a diagnosable code', () => {
    const parsed = AgentInbound.safeParse({ type: 'auth', api_key: 'k', project_dir: 'C:/x' })
    expect(parsed.success).toBe(true)
  })

  it('enforcement is OFF by default (installed MSIs must not be bricked)', () => {
    expect(isHostnameRequiredOnAgentAuth({})).toBe(false)
    expect(isHostnameRequiredOnAgentAuth({ REMO_WS_REQUIRE_HOSTNAME: '' })).toBe(false)
    expect(isHostnameRequiredOnAgentAuth({ REMO_WS_REQUIRE_HOSTNAME: '0' })).toBe(false)
    expect(isHostnameRequiredOnAgentAuth({ REMO_WS_REQUIRE_HOSTNAME: 'off' })).toBe(false)
  })

  it('enforcement flips on for 1|true|yes|on', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
      expect(isHostnameRequiredOnAgentAuth({ REMO_WS_REQUIRE_HOSTNAME: v })).toBe(true)
    }
  })
})
