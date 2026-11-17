/**
 * PTYCAP-05 plan 06 (F1-6): the proof's never-merge control is GitHub-side only. The orchestrator
 * session is exempt from the git-push credential scrub, so NO proof module may reference or rely
 * on it. A negative fixture proves the scanner would catch a regression.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const ORCH = join(SRC, 'orchestrator')
const DAL = join(SRC, 'db', 'orchestrator-proof-dal.ts')

const FORBIDDEN = /env-sanitize|sanitizeSpawnEnv|scrubDeployCredentials/

function proofModules(): string[] {
  return [...readdirSync(ORCH).filter((f) => f.startsWith('proof-') && f.endsWith('.ts')).map((f) => join(ORCH, f)), DAL]
}

/** Lines of `src` that reference the credential-scrub helpers. */
export function scrubReferences(src: string): string[] {
  return src.split(/\r?\n/).filter((l) => FORBIDDEN.test(l))
}

describe('no reliance on credential scrubbing in the proof modules', () => {
  test('the scan covers the guard, the evaluators and the DAL (a broken glob would fail here)', () => {
    const names = proofModules().map((p) => p.split(/[\\/]/).pop())
    for (const n of ['proof-guard.ts', 'proof-evaluators.ts', 'proof-protection.ts', 'proof-verifier.ts', 'orchestrator-proof-dal.ts']) {
      expect(names).toContain(n)
    }
  })

  test('no proof module references env-sanitize / sanitizeSpawnEnv / scrubDeployCredentials', () => {
    const offenders = proofModules().flatMap((f) => scrubReferences(readFileSync(f, 'utf8')).map((l) => `${f}: ${l.trim()}`))
    expect(offenders).toEqual([])
  })

  test('negative fixture: introducing scrubDeployCredentials into a proof module is caught', () => {
    const bad = `import { sanitizeSpawnEnv } from '../../../supervisor/src/runners/env-sanitize.ts'\nconst e = sanitizeSpawnEnv(process.env, { scrubDeployCredentials: true })\n`
    expect(scrubReferences(bad).length).toBe(2)
    expect(scrubReferences('const ok = 1')).toEqual([])
  })
})
