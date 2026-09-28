/**
 * PTYCAP Phase 2 — `DispatchRequest.humanInteractive` exempts a request from the
 * programmatic-credit halt in `dailyCostCapGate`. It must only ever be SET by
 * the server-side PTY preflight (`pty-preflight.ts`), never from client input.
 * This guard pins every source occurrence so a new construction site (e.g. one
 * spreading a request body into a DispatchRequest) fails CI until reviewed.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const ALLOWED = new Set([
  'dispatch/pipeline.ts', //      the type declaration
  'dispatch/gates.ts', //         the one reader (dailyCostCapGate)
  'dispatch/pty-preflight.ts', // the one writer (runChain, human actor)
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('humanInteractive trust boundary', () => {
  test('only pipeline.ts (type), gates.ts (read) and pty-preflight.ts (set) mention it', () => {
    const offenders = walk(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes('humanInteractive'))
      .map((f) => relative(SRC, f).split('\\').join('/'))
      .filter((f) => !ALLOWED.has(f))
    expect(offenders).toEqual([])
  })

  test('pty-preflight.ts sets it only for the server-inferred human actor', () => {
    const src = readFileSync(join(SRC, 'dispatch/pty-preflight.ts'), 'utf8')
    const sets = src.split('\n').filter((l) => /humanInteractive\s*:/.test(l))
    expect(sets).toEqual(["    ...(human ? { humanInteractive: true as const } : {}),"])
  })
})
