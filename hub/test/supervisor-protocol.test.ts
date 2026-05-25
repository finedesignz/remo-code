import { describe, expect, test } from 'bun:test'
import { AgentInbound } from '../src/ws/agent-protocol'

// Regression: supervisor's WS hello sequence must pass AgentInbound schema.
// Symptom this guards: supervisor WS closes ~600ms after connect with no
// `[supervisor] authenticated` log → root cause was silent safeParse drop.
describe('supervisor → hub WS protocol', () => {
  test('auth payload (real shape from supervisor/src/hub-client.ts) parses', () => {
    const r = AgentInbound.safeParse({
      type: 'auth',
      api_key: 'sk_test_abcdef',
      project_dir: '__supervisor__',
      hostname: 'WIN-HOST',
      role: 'supervisor',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.type).toBe('auth')
      expect((r.data as any).role).toBe('supervisor')
    }
  })

  test('supervisor.hello parses', () => {
    const r = AgentInbound.safeParse({
      type: 'supervisor.hello',
      version: '0.2.0',
      os: 'win32 10.0.26200',
      hostname: 'WIN-HOST',
      roots: ['C:/Users/artic/GitHub'],
      capabilities: ['supervisor', 'agent'],
    })
    expect(r.success).toBe(true)
  })

  test('supervisor.commands_sync parses', () => {
    const r = AgentInbound.safeParse({
      type: 'supervisor.commands_sync',
      commands: [
        { kind: 'command', name: 'deploy', description: null, source: 'project', path: '.claude/commands/deploy.md' },
        { kind: 'skill', name: 'gsd', description: 'get shit done', source: 'global', path: '~/.claude/skills/gsd' },
      ],
    })
    expect(r.success).toBe(true)
  })

  test('supervisor.state parses (all optional fields omitted)', () => {
    const r = AgentInbound.safeParse({ type: 'supervisor.state', state: 'idle' })
    expect(r.success).toBe(true)
  })

  test('supervisor.log parses', () => {
    const r = AgentInbound.safeParse({
      type: 'supervisor.log',
      level: 'info',
      message: 'authenticated; sending hello',
      ts: new Date().toISOString(),
    })
    expect(r.success).toBe(true)
  })
})
