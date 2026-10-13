/**
 * PTYCAP-04-05 Task 2 / D-16 / research S1: static pin on the boot order in
 * hub/src/index.ts.
 *  - env half: assertAutomationControlsEnv() runs synchronously BEFORE Bun.serve, in the
 *    same try/catch + FATAL + exit(1) shape as assertTokenCapConfig.
 *  - table half: assertAutomationControlsTables() is the FIRST step after runMigrations()
 *    resolves (before setOfflineStaleAgentSessions), with its own catch that exits 1.
 *    A table check BEFORE runMigrations would exit on the very first deploy.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const lines = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8').split(/\r?\n/)
const idx = (re: RegExp, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l))

const ENV_CALL = idx(/^\s*assertAutomationControlsEnv\(\)\s*$/)
const SERVE = idx(/^const server = Bun\.serve\(/)
const MIGRATE = idx(/^runMigrations\(\)\s*$/)
const TABLES = idx(/^\s*\.then\(\(\) => assertAutomationControlsTables\(\)/)
const OFFLINE = idx(/^\s*\.then\(\(\) => setOfflineStaleAgentSessions\(\)\)/)
const TOKEN_CAP = idx(/^\s*assertTokenCapConfig\(\)\s*$/)

describe('automation boot order (static pin over index.ts)', () => {
  test('self-check: every anchor is found', () => {
    for (const [name, v] of Object.entries({ ENV_CALL, SERVE, MIGRATE, TABLES, OFFLINE, TOKEN_CAP })) {
      expect(v, `anchor ${name} not found in hub/src/index.ts`).toBeGreaterThanOrEqual(0)
    }
  })

  test('env assertion precedes Bun.serve and follows the token-cap assertion', () => {
    expect(ENV_CALL).toBeGreaterThan(TOKEN_CAP)
    expect(ENV_CALL).toBeLessThan(SERVE)
  })

  test('env assertion uses the same try/catch + FATAL + exit(1) shape as the token cap', () => {
    expect(lines[ENV_CALL - 1].trim()).toBe('try {')
    const tail = lines.slice(ENV_CALL + 1, ENV_CALL + 5).map((l) => l.trim())
    expect(tail[0]).toMatch(/^\} catch \(err: any\) \{$/)
    expect(tail[1]).toContain('[startup] FATAL:')
    expect(tail[2]).toBe('process.exit(1)')
    expect(tail[3]).toBe('}')
  })

  test('table assertion is the first step after runMigrations() and precedes setOfflineStaleAgentSessions', () => {
    expect(TABLES).toBeGreaterThan(MIGRATE)
    expect(TABLES).toBeLessThan(OFFLINE)
    // nothing but comments between runMigrations() and the table assertion
    const between = lines.slice(MIGRATE + 1, TABLES).filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
    expect(between).toEqual([])
  })

  test('table assertion has its own catch that logs FATAL and exits 1', () => {
    const block = lines.slice(TABLES, OFFLINE).join('\n')
    expect(block).toContain('.catch(')
    expect(block).toContain('[startup] FATAL:')
    expect(block).toContain('process.exit(1)')
  })

  test('the table assertion is never called before runMigrations()', () => {
    const before = lines.slice(0, MIGRATE).filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(before).not.toContain('assertAutomationControlsTables()')
  })
})
