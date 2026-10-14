/**
 * PTYCAP-04-06 (SC-2, D-05, D-08): kill-switch + lifetime-counter coverage guard.
 *
 * "Halts all machine-initiated automation" is only true if EVERY non-human dispatch
 * list carries the kill-switch gate, FIRST. Modeled on token-cap-coverage.test.ts:
 * a bracket-balanced scan of every `gates: [ ... ]` literal in hub/src, with default
 * DENY -- a list that is neither classified HUMAN, nor the PTY door, nor carries the
 * kill gate first, fails CI. A list the scanner cannot parse hard-fails too.
 *
 * Classification (04-FORKS F-2, panel-locked):
 *   HUMAN      telegram/dispatch.ts, cloud/send.ts -- a person typing; MUST NOT be kill-gated.
 *   PTY DOOR   dispatch/pty-preflight.ts -- shared array, also the source of
 *              PTY_HUMAN_TURN_GATES; the kill switch rides the governor slot on the
 *              automation branch (governed-pty.ts), never this array.
 *   MACHINE    everything else -- kill gate FIRST. Counted (lifetime counter LAST) or
 *              explicitly exempt with a reason.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(import.meta.dir, '..', 'src')
const KILL = 'automationKillSwitchGate'
const COUNTER = 'automationLifetimeCounterGate'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

interface GateList { file: string; list: string; elements: string[] }

/** Strip // and block comments so a comment inside a list cannot hide or fake an element. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1')
}

/** Split a list body on top-level commas (bracket/paren/brace aware). */
function topLevelElements(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of stripComments(body)) {
    if (ch === '[' || ch === '(' || ch === '{') depth++
    else if (ch === ']' || ch === ')' || ch === '}') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** Identifier at the head of an element: `governedAutomationPtyGate(...)` -> that name. */
function headName(el: string): string {
  const m = /^[A-Za-z_$][\w$]*/.exec(el)
  return m ? m[0] : el
}

function gateLists(): { lists: GateList[]; unparsed: string[] } {
  const lists: GateList[] = []
  const unparsed: string[] = []
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf-8')
    const rel = file.slice(SRC.length + 1).replace(/\\/g, '/')
    for (const m of src.matchAll(/gates:\s*\[/g)) {
      const open = m.index! + m[0].length - 1
      let depth = 0
      let end = -1
      for (let i = open; i < src.length; i++) {
        const ch = src[i]
        if (ch === '[' || ch === '(' || ch === '{') depth++
        else if (ch === ']' || ch === ')' || ch === '}') {
          depth--
          if (depth === 0) { end = i; break }
        }
      }
      if (end === -1) { unparsed.push(`${rel}: unbalanced gates: [ at offset ${open}`); continue }
      const list = src.slice(open + 1, end)
      lists.push({ file: rel, list, elements: topLevelElements(list) })
    }
  }
  return { lists, unparsed }
}

/** Humans keep working during a halt (F-2, Phase 3 D-07). Reason strings are load-bearing documentation. */
const HUMAN: Record<string, string> = {
  'telegram/dispatch.ts':
    'sole caller (the Telegram webhook) passes source human: a person typing a message; a halt must not lock the owner out of their own sessions',
  'cloud/send.ts':
    'cloud web chat: a human typing into a cloud session; never machine-initiated',
}

/** The shared PTY pre-flight array: not kill-gated here, covered by the governor slot. */
const PTY_DOOR = 'dispatch/pty-preflight.ts'

/** Lists that carry the lifetime counter (LAST element). Key-bearing paths (D-05). */
const COUNTED = new Set(['orchestrator/inject.ts', 'scheduler/senders/agent.ts', 'scheduler/senders/triage.ts'])

/** Machine lists deliberately NOT counted. One reason each; a new machine list must pick a side. */
const COUNTER_EXEMPT: Record<string, string> = {
  'error-capture/dispatcher.ts': 'event stream with no task identity; a per-session cap would brick a busy repo self-heal',
  'feedback/dispatcher.ts': 'event stream with no task identity; bounded by per-token/per-IP rate limit and the spend caps',
  'revanote/dispatcher.ts': 'event stream with no task identity; bounded by the revanote budget gate and the spend caps',
  'ask/dispatch.ts': 'key-less external ask; bounded by askRateGate (per api key) and the spend caps',
  'work/dispatch.ts': 'key-less external email work; bounded by workRateGate, the repo allowlist and the spend caps',
}

const KNOWN_FILES = [
  'ask/dispatch.ts',
  'cloud/send.ts',
  'dispatch/pty-preflight.ts',
  'error-capture/dispatcher.ts',
  'feedback/dispatcher.ts',
  'orchestrator/inject.ts',
  'revanote/dispatcher.ts',
  'scheduler/senders/agent.ts',
  'scheduler/senders/triage.ts',
  'telegram/dispatch.ts',
  'work/dispatch.ts',
]

const isMachine = (f: string) => !(f in HUMAN) && f !== PTY_DOOR

describe('kill switch covers every machine-initiated dispatch list', () => {
  test('every gates: [ ... ] occurrence is PARSEABLE (an unparsed list hard-fails, never passes silently)', () => {
    expect(gateLists().unparsed).toEqual([])
  })

  test('the scan actually found the known dispatchers (12 lists, inject.ts twice)', () => {
    const { lists } = gateLists()
    const files = new Set(lists.map((g) => g.file))
    for (const f of KNOWN_FILES) expect(files.has(f), `scanner did not find ${f}`).toBe(true)
    expect(lists.filter((g) => g.file === 'orchestrator/inject.ts')).toHaveLength(2)
    expect(lists).toHaveLength(12)
  })

  test('scanner self-check: element splitting handles nested calls, comments and trailing commas', () => {
    expect(topLevelElements('a, f(x, [1, 2]), // c, d\n  b,')).toEqual(['a', 'f(x, [1, 2])', 'b'])
    expect(headName('governedAutomationPtyGate(async (req) => { return 1 })')).toBe('governedAutomationPtyGate')
  })

  test('every MACHINE list carries the kill-switch gate as its FIRST element (default deny)', () => {
    const offenders = gateLists().lists
      .filter((g) => isMachine(g.file))
      .filter((g) => headName(g.elements[0] ?? '') !== KILL)
      .map((g) => `${g.file}: gates: [${g.list.trim()}]`)
    expect(offenders).toEqual([])
  })

  test('HUMAN lists exist and carry NO kill-switch (humans keep working during a halt)', () => {
    const { lists } = gateLists()
    for (const file of Object.keys(HUMAN)) {
      const found = lists.filter((g) => g.file === file)
      expect(found.length, `${file} list not found`).toBeGreaterThan(0)
      for (const g of found) {
        expect(g.list.includes(KILL), `${file} must not be kill-gated: ${HUMAN[file]}`).toBe(false)
        expect(g.list.includes(COUNTER), `${file} must not be counted`).toBe(false)
      }
    }
  })

  test('human classifications carry a reason; the telegram entry documents the human-source caller', () => {
    for (const [file, reason] of Object.entries(HUMAN)) expect(reason.length, file).toBeGreaterThan(20)
    expect(HUMAN['telegram/dispatch.ts']).toContain('source human')
  })

  test('PTY door: array carries no kill gate; the automation branch runs activeGovernors(); the kill governor is killSwitchCheck', () => {
    const { lists } = gateLists()
    const pty = lists.filter((g) => g.file === PTY_DOOR)
    expect(pty).toHaveLength(1)
    expect(pty[0].list.includes(KILL)).toBe(false)
    expect(pty[0].list.includes(COUNTER)).toBe(false)
    const preflight = readFileSync(join(SRC, 'dispatch/pty-preflight.ts'), 'utf-8')
    expect(preflight).toContain('activeGovernors()')
    const governed = readFileSync(join(SRC, 'dispatch/governed-pty.ts'), 'utf-8')
    expect(governed).toContain('killSwitchCheck')
  })

  test('counter coverage: counted lists carry the lifetime counter LAST; every other machine list is explicitly exempt with a reason', () => {
    const problems: string[] = []
    for (const g of gateLists().lists.filter((x) => isMachine(x.file))) {
      if (COUNTED.has(g.file)) {
        if (headName(g.elements[g.elements.length - 1] ?? '') !== COUNTER) {
          problems.push(`${g.file}: counted list must end with ${COUNTER}`)
        }
      } else if (!(g.file in COUNTER_EXEMPT)) {
        problems.push(`${g.file}: neither counted nor in the exemption map -- classify it (default deny)`)
      } else if (g.list.includes(COUNTER)) {
        problems.push(`${g.file}: exempt list must not carry ${COUNTER}`)
      }
    }
    expect(problems).toEqual([])
  })

  test('every exemption/human/counted entry names a file that still exists in the scan (no stale classification)', () => {
    const files = new Set(gateLists().lists.map((g) => g.file))
    for (const f of [...Object.keys(HUMAN), ...Object.keys(COUNTER_EXEMPT), ...COUNTED, PTY_DOOR]) {
      expect(files.has(f), `stale classification: ${f}`).toBe(true)
    }
    for (const reason of Object.values(COUNTER_EXEMPT)) expect(reason.length).toBeGreaterThan(20)
  })

  test('no human or PTY-door source file imports the kill-switch gate', () => {
    for (const rel of ['cloud/send.ts', 'telegram/dispatch.ts', 'dispatch/pty-preflight.ts']) {
      const src = readFileSync(join(SRC, rel), 'utf-8')
      expect(src.includes(KILL), `${rel} must not reference ${KILL}`).toBe(false)
    }
  })
})
