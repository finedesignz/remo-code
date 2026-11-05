// PTYCAP-05-07 task 3: the operator CLI is DATA ONLY. Static scan: no env flag/cap assignment,
// no hosting-provider reference, no non-GitHub network call, no SQL text, no token-cap setter;
// plus a spawned no-database dry run that must refuse before touching anything.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SCRIPT = join(ROOT, 'scripts', 'arm-orchestrator-proof.ts')
const CORE = join(ROOT, 'src', 'orchestrator', 'proof-arm.ts')

const read = (p: string) => readFileSync(p, 'utf-8')
const FILES: Array<[string, string]> = [
  ['scripts/arm-orchestrator-proof.ts', SCRIPT],
  ['src/orchestrator/proof-arm.ts', CORE],
]

describe('arm script static guard', () => {
  for (const [name, path] of FILES) {
    const src = read(path)

    test(`${name}: no assignment to process.env`, () => {
      expect(/process\.env(\.[A-Za-z_0-9]+|\[[^\]]+\])\s*=[^=]/.test(src)).toBe(false)
      expect(/Object\.assign\(\s*process\.env/.test(src)).toBe(false)
    })

    test(`${name}: no Coolify reference`, () => {
      expect(/coolify/i.test(src)).toBe(false)
    })

    test(`${name}: no network call and no URL literal`, () => {
      expect(/\bfetch\s*\(/.test(src)).toBe(false)
      expect(/https?:\/\//.test(src)).toBe(false)
      expect(/from\s+['"]node:https?['"]/.test(src)).toBe(false)
    })

    test(`${name}: no SQL statement text`, () => {
      expect(/\b(SELECT\s+[\s\S]{0,80}?\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s|DROP\s+TABLE)\b/i.test(src)).toBe(false)
      expect(/\bsql\s*`/.test(src)).toBe(false)
    })

    test(`${name}: no token-cap setter or flag name set`, () => {
      expect(/setTokenCap|setDailyTokenCap|DAILY_TOKEN_CAP\s*=/.test(src)).toBe(false)
      expect(/REMO_ORCHESTRATOR_[A-Z_]+\s*=/.test(src)).toBe(false)
    })
  }

  test('the script header states DATA ONLY, the rule 6 note and the frozen budgets', () => {
    const src = read(SCRIPT)
    const header = src.slice(0, src.indexOf('*/'))
    expect(header).toContain('DATA ONLY')
    expect(header).toMatch(/rule 6/i)
    expect(header).toMatch(/frozen/i)
  })

  test('the script imports only the arm core, the DAL and the real adapters (lazily)', () => {
    const src = read(SCRIPT)
    expect(/^import\s/m.test(src)).toBe(false)
    const lazy = [...src.matchAll(/await import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    const allowed = [
      '../src/orchestrator/proof-arm.ts',
      '../src/orchestrator/proof-github.ts',
      '../src/auth/github-app.ts',
      '../src/db/orchestrator-proof-dal.ts',
      '../src/db/orchestrator-proof-arm-reads.ts',
      '../src/db/orchestrator-rows-dal.ts',
      '../src/dispatch/automation-controls.ts',
    ]
    expect(lazy.length).toBeGreaterThan(0)
    for (const m of lazy) expect(allowed).toContain(m)
  })
})

function runScript(args: string[], env: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'arm-proof-guard-'))
  try {
    const p = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

// Scrubbed env: no DATABASE_URL, no REMO_*, no GitHub App credentials.
const scrubbed = (): Record<string, string> => {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
  const env: Record<string, string> = {}
  for (const k of keep) if (process.env[k]) env[k] = process.env[k] as string
  return env
}

const FULL_ARGS = ['--user', 'u1', '--session', 's1', '--repo-ident', 'github://acme/proof', '--installation-id', '4242']

describe('arm script spawned with no database', () => {
  test('--dry-run with no DATABASE_URL exits non-zero, prints nothing to stdout, mutates nothing', () => {
    const r = runScript([...FULL_ARGS, '--dry-run'], scrubbed())
    expect(r.code).not.toBe(0)
    expect(r.code).toBe(2)
    expect(r.out.trim()).toBe('')
    expect(r.err).toContain('DATABASE_URL')
  })

  test('arm and --disarm and --enable also refuse before any import when there is no database', () => {
    expect(runScript(FULL_ARGS, scrubbed()).code).toBe(2)
    expect(runScript(['--user', 'u1', '--disarm'], scrubbed()).code).toBe(2)
    expect(runScript(['--user', 'u1', '--enable'], scrubbed()).code).toBe(2)
  })

  test('missing or conflicting arguments exit 2 with a usage message', () => {
    const none = runScript([], scrubbed())
    expect(none.code).toBe(2)
    expect(none.err.toLowerCase()).toContain('usage')
    const two = runScript([...FULL_ARGS, '--dry-run', '--enable'], scrubbed())
    expect(two.code).toBe(2)
    const badId = runScript(['--user', 'u', '--session', 's', '--repo-ident', 'github://a/b', '--installation-id', 'abc'], scrubbed())
    expect(badId.code).toBe(2)
  })
})
