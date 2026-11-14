// CORCH-09 (R4.3, R3.8): the hub never holds a token, and no corch.* frame leaves without haltBeforeMachineSend.
//   1. no hub source or schema names the slot OAuth token env or a token column
//   2. no CORCH hub code reads or names a provider API key, or reads any credential env
//   3. the corch.* command names live only in the one sender module and the RPC allowlist, and every sender call
//      is immediately preceded by the kill-switch halt check
// Static scans (default deny); the runtime behaviour is pinned in corch-workspace.test.ts.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const rel = (p: string) => relative(SRC, p).split('\\').join('/')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1')
const FILES = walk(SRC).map((f) => ({ f: rel(f), code: strip(readFileSync(f, 'utf-8')), raw: readFileSync(f, 'utf-8') }))
const CORCH = FILES.filter((x) => x.f.startsWith('corch/'))

describe('R4.3 no token in the hub', () => {
  test('no hub source (comments included) names CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(FILES.filter((x) => x.raw.includes('CLAUDE_CODE_OAUTH_TOKEN')).map((x) => x.f)).toEqual([])
  })

  test('schema.sql has no oauth/token-value column for CORCH or the slot', () => {
    const ddl = readFileSync(join(SRC, 'db', 'schema.sql'), 'utf-8')
    expect(ddl.includes('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false)
    const corchDdl = ddl.split(/\r?\n/).filter((l) => /corch/i.test(l) || /^\s+(oauth|claude_token|slot_token)/i.test(l))
    expect(corchDdl.filter((l) => /oauth|claude_token|slot_token|api_key/i.test(l))).toEqual([])
  })

  test('CORCH hub code never names a provider API key', () => {
    const hits = CORCH.filter((x) => /ANTHROPIC_API_KEY|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN/.test(x.raw)).map((x) => x.f)
    expect(hits).toEqual([])
  })

  test('the slot modules read NO environment at all', () => {
    for (const f of ['corch/workspace.ts', 'corch/memlog.ts']) {
      const x = FILES.find((y) => y.f === f)!
      expect(/process\.env|Bun\.env/.test(x.code)).toBe(false)
    }
  })

  test('the hub sends no env/token field in any corch.* RPC (args are identifiers and paths only)', () => {
    const ws = FILES.find((x) => x.f === 'corch/workspace.ts')!
    const calls = [...ws.code.matchAll(/runCommand\(([^)]*)\)/g)].map((m) => m[1]!)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(/env|token|secret|key/i.test(c)).toBe(false)
  })
})

describe('R4.4 haltBeforeMachineSend precedes every corch.* frame', () => {
  const NAMES = /['"`]corch\.(worktree_ensure|worktree_remove|pr_lookup)['"`]/

  test('the command names appear only in the sender module, the RPC allowlist and the type', () => {
    const holders = FILES.filter((x) => NAMES.test(x.code)).map((x) => x.f).sort()
    expect(holders).toEqual(['corch/workspace.ts', 'ext/supervisor-read.ts'])
  })

  test('every runCommand call in workspace.ts is directly preceded by deps.halt()', () => {
    const lines = FILES.find((x) => x.f === 'corch/workspace.ts')!.code.split(/\r?\n/)
    const at = lines.map((l, i) => (/deps\.runCommand\(/.test(l) ? i : -1)).filter((i) => i >= 0)
    expect(at.length).toBe(2) // send() and PrLookup
    for (const i of at) {
      const window = lines.slice(Math.max(0, i - 6), i).join('\n')
      expect(window).toMatch(/deps\.halt\(/)
    }
  })
})
