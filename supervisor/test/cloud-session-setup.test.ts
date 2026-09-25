// tools/cloud-session helpers (docs/cloud-session-supervisor.md).
import { describe, it, expect } from 'bun:test'
import { buildCloudConfig } from '../../tools/cloud-session/write-config'
import { withStartHook } from '../../tools/cloud-session/install-hook'

describe('buildCloudConfig', () => {
  it('requires REMO_API_KEY', () => {
    expect(() => buildCloudConfig({})).toThrow(/REMO_API_KEY/)
  })
  it('defaults: hosted hub, /home/user root, 2 concurrent, no skip-permissions, claude TUI', () => {
    const c = buildCloudConfig({ REMO_API_KEY: 'remokey_x' })
    expect(c).toMatchObject({
      hub_url: 'https://app.remo-code.com',
      api_key: 'remokey_x',
      roots: ['/home/user'],
      max_concurrent: 2,
      allow_dangerous_skip_permissions: false,
      autostart: false,
      default_human_backend: 'claude',
      claude_interactive_confirmed: true,
    })
  })
  it('reads overrides', () => {
    const c = buildCloudConfig({
      REMO_API_KEY: 'k', REMO_HUB_URL: 'https://h', REMO_ROOTS: '/a:/b', REMO_MAX_CONCURRENT: '4', REMO_ALLOW_DANGEROUS: '1',
    })
    expect(c).toMatchObject({ hub_url: 'https://h', roots: ['/a', '/b'], max_concurrent: 4, allow_dangerous_skip_permissions: true })
  })
  it('falls back on a bad REMO_MAX_CONCURRENT', () => {
    expect(buildCloudConfig({ REMO_API_KEY: 'k', REMO_MAX_CONCURRENT: 'x' }).max_concurrent).toBe(2)
  })
})

describe('withStartHook', () => {
  it('adds a SessionStart hook, preserving other settings and hooks', () => {
    const out = withStartHook({ model: 'x', hooks: { Stop: [{ hooks: [] }] } }, 'bash /s.sh')
    expect(out.model).toBe('x')
    expect(out.hooks.Stop).toEqual([{ hooks: [] }])
    expect(out.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'bash /s.sh' }] }])
  })
  it('is idempotent', () => {
    const once = withStartHook({}, 'bash /s.sh')
    expect(withStartHook(once, 'bash /s.sh')).toEqual(once)
  })
})
