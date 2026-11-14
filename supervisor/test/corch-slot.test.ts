/**
 * CORCH-09 (R4.1, R4.2, R4.3): slot advertisement, per-slot spawn env, and "no env value leaves the supervisor".
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRunner } from '../src/runners/claude-runner'
import { accountSlot, slotSpawnEnv, SlotConfigError } from '../src/slot'
import { SupervisorClient } from '../src/hub-client'
import { defaultConfig } from '../src/config'
import { getHandler } from '../src/commands/index'
import { __setCorchWorktreeForTest } from '../src/commands/corch-worktree'

const SENTINEL_TOKEN = 'sk-ant-oat01-SENTINEL-TOKEN-VALUE-DO-NOT-LEAK'
const SENTINEL_API = 'sk-ant-api03-SENTINEL-API-KEY-VALUE'
const SLOT_VARS = ['REMO_ACCOUNT_SLOT', 'REMO_SLOT_CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GH_TOKEN']
const saved: Record<string, string | undefined> = {}
for (const k of SLOT_VARS) saved[k] = process.env[k]
afterEach(() => {
  for (const k of SLOT_VARS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
function clearSlotEnv(): void {
  for (const k of SLOT_VARS) delete process.env[k]
}

function fakeSpawn(captured: { opts?: any }) {
  return (_cmd: string[], opts: any) => {
    captured.opts = opts
    return {
      pid: 4242,
      exited: new Promise(() => {}),
      stdin: { write: () => {}, flush: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      kill: () => {},
    } as any
  }
}

function spawnEnv(): { env: NodeJS.ProcessEnv | undefined; events: any[] } {
  const dir = mkdtempSync(join(tmpdir(), 'corch-slot-'))
  const cap: { opts?: any } = {}
  const events: any[] = []
  const r = new ClaudeRunner(dir, false)
  r.spawnImpl = fakeSpawn(cap)
  r.start((e) => events.push(e))
  r.stop()
  rmSync(dir, { recursive: true, force: true })
  return { env: cap.opts?.env, events }
}

describe('account slot (R4.1)', () => {
  test('accountSlot is null unless REMO_ACCOUNT_SLOT is a valid slot id', () => {
    expect(accountSlot({})).toBeNull()
    expect(accountSlot({ REMO_ACCOUNT_SLOT: '  ' })).toBeNull()
    expect(accountSlot({ REMO_ACCOUNT_SLOT: 'bad slot!' })).toBeNull()
    expect(accountSlot({ REMO_ACCOUNT_SLOT: 'acct_1-A' })).toBe('acct_1-A')
  })

  async function helloFrames(): Promise<any[]> {
    const frames: any[] = []
    // Isolate from the real ~/.claude (the command scan would walk every installed skill) and the real config dir.
    const home = mkdtempSync(join(tmpdir(), 'corch-slot-home-'))
    const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CFG: process.env.REMO_CODE_CONFIG_DIR }
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.REMO_CODE_CONFIG_DIR = home
    const c = new SupervisorClient(defaultConfig())
    ;(c as any).ws = { readyState: WebSocket.OPEN, send: (s: string) => frames.push(JSON.parse(s)), close() {} }
    await (c as any).handleMessage({ type: 'auth_ok' })
    await new Promise((r) => setTimeout(r, 50))
    for (const [k, v] of [['HOME', prev.HOME], ['USERPROFILE', prev.USERPROFILE], ['REMO_CODE_CONFIG_DIR', prev.CFG]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
    return frames
  }

  test('hello carries account_slot ONLY with REMO_ACCOUNT_SLOT set; no frame carries a token value', async () => {
    clearSlotEnv()
    const off = (await helloFrames()).find((f) => f.type === 'supervisor.hello')
    expect(off).toBeDefined()
    expect('account_slot' in off).toBe(false)

    process.env.REMO_ACCOUNT_SLOT = 'acct_main'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = SENTINEL_TOKEN
    process.env.ANTHROPIC_API_KEY = SENTINEL_API
    process.env.GH_TOKEN = 'ghp_SENTINEL_GIT'
    const frames = await helloFrames()
    const on = frames.find((f) => f.type === 'supervisor.hello')
    expect(on.account_slot).toBe('acct_main')
    // R4.3 frame test: nothing the supervisor emitted (hello, commands_sync, logs, ...) carries an env value.
    const wire = JSON.stringify(frames)
    for (const secret of [SENTINEL_TOKEN, SENTINEL_API, 'ghp_SENTINEL_GIT']) expect(wire.includes(secret)).toBe(false)
  }, 60_000)
})

describe('per-slot spawn env (R4.2)', () => {
  test('no slot: no CLAUDE_CONFIG_DIR is injected and ANTHROPIC_API_KEY is scrubbed (previous behavior)', () => {
    clearSlotEnv()
    process.env.ANTHROPIC_API_KEY = SENTINEL_API
    const { env } = spawnEnv()
    expect(env).toBeDefined()
    expect(env!.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env!.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  test('slot set: OAuth token + CLAUDE_CONFIG_DIR reach the child, ANTHROPIC_API_KEY stays scrubbed', () => {
    clearSlotEnv()
    process.env.REMO_ACCOUNT_SLOT = 'acct_main'
    process.env.REMO_SLOT_CLAUDE_CONFIG_DIR = '/data/slots/acct_main/.claude'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = SENTINEL_TOKEN
    process.env.ANTHROPIC_API_KEY = SENTINEL_API
    const { env } = spawnEnv()
    expect(env!.CLAUDE_CODE_OAUTH_TOKEN).toBe(SENTINEL_TOKEN)
    expect(env!.CLAUDE_CONFIG_DIR).toBe('/data/slots/acct_main/.claude')
    expect(env!.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('slot set without token or config dir: the spawn is refused (fail closed, code only)', () => {
    clearSlotEnv()
    process.env.REMO_ACCOUNT_SLOT = 'acct_main'
    process.env.REMO_SLOT_CLAUDE_CONFIG_DIR = '/data/x'
    const noToken = spawnEnv()
    expect(noToken.env).toBeUndefined()
    expect(noToken.events.some((e) => e.type === 'error' && /slot_token_missing/.test(e.message))).toBe(true)

    process.env.CLAUDE_CODE_OAUTH_TOKEN = SENTINEL_TOKEN
    delete process.env.REMO_SLOT_CLAUDE_CONFIG_DIR
    const noDir = spawnEnv()
    expect(noDir.env).toBeUndefined()
    expect(noDir.events.some((e) => e.type === 'error' && /slot_config_dir_missing/.test(e.message))).toBe(true)
    expect(JSON.stringify([noToken.events, noDir.events]).includes(SENTINEL_TOKEN)).toBe(false)
  })

  test('slotSpawnEnv is the identity without a slot and never throws a value', () => {
    const base = { PATH: '/bin' }
    expect(slotSpawnEnv(base, {})).toBe(base)
    try {
      slotSpawnEnv(base, { REMO_ACCOUNT_SLOT: 'a', CLAUDE_CODE_OAUTH_TOKEN: SENTINEL_TOKEN })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SlotConfigError)
      expect(String((e as Error).message)).not.toContain(SENTINEL_TOKEN)
    }
  })

  test('human PTY env path is unchanged: still no API key and no slot injection', async () => {
    const { buildCodexPtyHostEnv } = await import('../src/runners/codex-pty-runner')
    process.env.REMO_ACCOUNT_SLOT = 'acct_main'
    process.env.REMO_SLOT_CLAUDE_CONFIG_DIR = '/data/slots/x'
    const env = buildCodexPtyHostEnv({ ANTHROPIC_API_KEY: SENTINEL_API, PATH: '/bin' } as any)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})

describe('corch.* replies carry no env value (R4.3)', () => {
  test('error and success replies never echo credentials', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = SENTINEL_TOKEN
    process.env.GH_TOKEN = 'ghp_SENTINEL_GIT'
    __setCorchWorktreeForTest({
      roots: () => [tmpdir()],
      exec: async () => ({ code: 1, out: `fatal: auth failed ${SENTINEL_TOKEN} ghp_SENTINEL_GIT` }),
    })
    try {
      for (const [cmd, args] of [
        ['corch.worktree_ensure', ['github://o/n', 'item-1']],
        ['corch.worktree_remove', ['github://o/n', 'item-1']],
        ['corch.pr_lookup', [tmpdir(), 'corch/item-1']],
      ] as const) {
        const r = await getHandler(cmd)!([...args])
        const wire = JSON.stringify(r)
        expect(wire.includes(SENTINEL_TOKEN)).toBe(false)
        expect(wire.includes('ghp_SENTINEL_GIT')).toBe(false)
      }
    } finally {
      __setCorchWorktreeForTest({ exec: null })
    }
  })
})
