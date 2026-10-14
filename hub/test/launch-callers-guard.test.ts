/**
 * PTYCAP-04-07 (D-09d): enumerating pin over every launchSessionForUser caller.
 *
 * launchSessionForUser is shared by MACHINE callers (orchestrator autospawn, scheduler agent
 * lazy launch, ext ask / work ensureOnline) and HUMAN callers (Telegram /doctor and
 * /commands). Machine callers must pass `machine: true` so the kill switch refuses them
 * during a halt; human callers must never mention it (they must not be blocked by
 * automation controls). Default deny: a call site in any other file fails until classified.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')

const MACHINE = new Set([
  // orchestrator/inject.ts no longer calls the primitive: BSA autospawn launches through the
  // shared adapter below (PTYCAP-07-04), which is the machine call site for it and for heal.
  'dispatch/governed-launch.ts', //    PTYCAP-07 shared governed autospawn adapter
  'scheduler/senders/agent.ts', //     maybeLaunchOfflineSession
  'ask/dispatch.ts', //                ensureOnline closure
  'work/dispatch.ts', //               ensureOnline closure
])
const HUMAN = new Set([
  'telegram/doctor.ts', //             /doctor autoheal relaunch
  'telegram/commands.ts', //           Telegram command relaunch (launchImpl)
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

function codeLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
}

interface Site { file: string; line: string }

function sites(): Site[] {
  const out: Site[] = []
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f).split('\\').join('/')
    for (const line of codeLines(f)) {
      if (/function\s+launchSessionForUser\b/.test(line)) continue // the definition
      if (/launchSessionForUser\s*\(/.test(line) || /\?\?\s*launchSessionForUser\b/.test(line)) {
        out.push({ file: rel, line })
      }
    }
  }
  return out
}

describe('launchSessionForUser caller classification', () => {
  const all = sites()

  test('self-check: the scanner finds all six known call sites', () => {
    expect(all.length).toBeGreaterThanOrEqual(6)
    const files = new Set(all.map((s) => s.file))
    for (const f of [...MACHINE, ...HUMAN]) expect(files.has(f)).toBe(true)
  })

  test('default deny: every call site is classified machine or human', () => {
    const unclassified = all.filter((s) => !MACHINE.has(s.file) && !HUMAN.has(s.file)).map((s) => s.file)
    expect(unclassified).toEqual([])
  })

  test('MACHINE callers pass machine: true on the call', () => {
    const bad = all.filter((s) => MACHINE.has(s.file) && !/machine:\s*true/.test(s.line)).map((s) => s.file)
    expect(bad).toEqual([])
  })

  test('the governed-launch adapter passes the machine option to the launch call (PTYCAP-07-04)', () => {
    const src = readFileSync(join(SRC, 'dispatch/governed-launch.ts'), 'utf8')
    expect(/launchSessionForUser\(\{[^}]*machine:\s*true/.test(src)).toBe(true)
  })

  test('HUMAN callers never pass the machine option', () => {
    for (const f of HUMAN) {
      const src = readFileSync(join(SRC, f), 'utf8')
      expect(/machine\s*:\s*true/.test(src)).toBe(false)
    }
  })
})
