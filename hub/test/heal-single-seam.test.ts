/**
 * PTYCAP-07-10 (SC1, D-12, AM-F4-3, SH-01/05/06): the single-seam guard.
 *
 * No failure source may build its own dispatch, capacity routing, supervisor frame or launch for a
 * heal. Three walls:
 *   (A) PIN TABLE - in the four source areas (api/coolify-webhook.ts, scheduler/**, error-capture/**,
 *       feedback/**, webhooks/**) each forbidden token is capped at its recorded count; a file not in
 *       the table must hold zero. The remaining legacy occurrences are the non-heal scheduler senders
 *       and the heal-legacy-path bodies kept for flag-OFF.
 *   (B) SEAM ISOLATION - inside hub/src/heal only route.ts owns the gate list, the dispatch calls and
 *       the lifetime key; no module there routes capacity, sends a supervisor frame, lists online
 *       agents, launches, reads the orchestrator-enabled predicate, spawns an interval timer or
 *       reads REMO_HEAL env outside config.ts/flag.ts.
 *   (C) POSITIVE - each source reads the flag before it reaches routeHeal.
 *
 * Pin derivation (pre-phase tree b25f07c2 and PLAN_BASE fe7379f give identical counts for these
 * files; comment-stripped, whole-word):
 *   git ls-tree -r --name-only <rev> -- hub/src | each .ts | git show <rev>:<f> | strip comments |
 *   count \bpickSessionTarget\b \bsendToSupervisor\b \blaunchSessionForUser\b
 *   \blistOnlineAgentSessionsForUser\b (^|[^\w$.])dispatch\s*\( and the session.start string literal.
 * (A raw `git grep -c` over-counts: it includes prose in comments.)
 *
 * Every scanner is proven against violating fixture strings (a guard with a hole is not a guard)
 * and self-checked against known legacy tokens (a scanner that finds nothing must fail).
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')

// ---------------------------------------------------------------- scanner

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ \t])\/\/.*$/gm, '$1')
}

const TOKENS = {
  pickSessionTarget: /\bpickSessionTarget\b/g,
  sendToSupervisor: /\bsendToSupervisor\b/g,
  launchSessionForUser: /\blaunchSessionForUser\b/g,
  listOnlineAgentSessionsForUser: /\blistOnlineAgentSessionsForUser\b/g,
  dispatchCall: /(^|[^A-Za-z0-9_$.])dispatch\s*\(/g,
  sessionStart: /['"`]session\.start['"`]/g,
} as const
type TokenName = keyof typeof TOKENS

function countForbidden(src: string): Partial<Record<TokenName, number>> {
  const code = stripComments(src)
  const out: Partial<Record<TokenName, number>> = {}
  for (const [name, re] of Object.entries(TOKENS)) {
    const n = (code.match(re) ?? []).length
    if (n > 0) out[name as TokenName] = n
  }
  return out
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}
const rel = (f: string) => relative(SRC, f).split('\\').join('/')
const read = (r: string) => readFileSync(join(SRC, r), 'utf8')
const code = (r: string) => stripComments(read(r))

const ALL = walk(SRC).map(rel)
const HEAL = ALL.filter((f) => f.startsWith('heal/'))
const inSourceAreas = (f: string) =>
  f === 'api/coolify-webhook.ts' ||
  f.startsWith('scheduler/') ||
  f.startsWith('error-capture/') ||
  f.startsWith('feedback/') ||
  f.startsWith('webhooks/')

/** The recorded pre-phase counts. Lowering one is fine; raising or adding a file is a seam violation. */
const PINS: Record<string, Partial<Record<TokenName, number>>> = {
  'api/coolify-webhook.ts': { listOnlineAgentSessionsForUser: 2 }, // dispatchTriageLegacy body
  'error-capture/dispatcher.ts': { dispatchCall: 1 }, // dispatchPendingErrorLegacy body
  'error-capture/setup/snippet.ts': { dispatchCall: 1 }, // emitted SDK snippet, not a hub dispatch
  'feedback/dispatcher.ts': { dispatchCall: 1 }, // dispatchFeedbackLegacy body
  'scheduler/senders/agent.ts': { launchSessionForUser: 2, dispatchCall: 1 }, // non-heal scheduled agent runs
  'scheduler/senders/triage.ts': { listOnlineAgentSessionsForUser: 2, dispatchCall: 1 }, // legacy triage (flag OFF)
}

// ---------------------------------------------------------------- (A) pin table

describe('SC1 (A): pinned legacy token counts in the four source areas', () => {
  test('no file in the source areas exceeds its pin; unlisted files hold zero', () => {
    const offenders: string[] = []
    for (const f of ALL.filter(inSourceAreas)) {
      const found = countForbidden(read(f))
      const pin = PINS[f] ?? {}
      for (const [tok, n] of Object.entries(found)) {
        const cap = pin[tok as TokenName] ?? 0
        if ((n as number) > cap) offenders.push(`${f}: ${tok} ${n} > pin ${cap}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('every pinned file still exists (a renamed file must not silently drop its pin)', () => {
    for (const f of Object.keys(PINS)) expect([f, ALL.includes(f)]).toEqual([f, true])
  })

  test('SELF-CHECK: the scanner finds the known legacy tokens in the known legacy files', () => {
    const triage = countForbidden(read('scheduler/senders/triage.ts'))
    expect(triage.listOnlineAgentSessionsForUser ?? 0).toBeGreaterThanOrEqual(1)
    expect(triage.dispatchCall ?? 0).toBeGreaterThanOrEqual(1)
    expect(countForbidden(read('scheduler/senders/agent.ts')).launchSessionForUser ?? 0).toBeGreaterThanOrEqual(1)
    expect(countForbidden(read('error-capture/dispatcher.ts')).dispatchCall ?? 0).toBeGreaterThanOrEqual(1)
    expect(ALL.filter(inSourceAreas).length).toBeGreaterThan(10)
  })

  test('PROOF: the scanner catches a violating fixture and ignores comment prose', () => {
    expect(countForbidden('const t = await pickSessionTarget(u)\n').pickSessionTarget).toBe(1)
    expect(countForbidden('sendToSupervisor(id, { type: "session.start" })').sendToSupervisor).toBe(1)
    expect(countForbidden("const m = { type: 'session.start' }").sessionStart).toBe(1)
    expect(countForbidden('await dispatch(req, deps)').dispatchCall).toBe(1)
    expect(countForbidden('await launchSessionForUser(a)').launchSessionForUser).toBe(1)
    expect(countForbidden('deps.dispatch(req)').dispatchCall).toBeUndefined() // member call on an injected dep
    expect(countForbidden('// pickSessionTarget( sendToSupervisor( dispatch(\n/* launchSessionForUser( */')).toEqual({})
  })

  test('the legacy bodies kept for flag-OFF sit between documented heal-legacy-path marker pairs', () => {
    const legacy: Array<[string, string]> = [
      ['api/coolify-webhook.ts', 'dispatchTriageLegacy'],
      ['error-capture/dispatcher.ts', 'dispatchPendingErrorLegacy'],
      ['feedback/dispatcher.ts', 'dispatchFeedbackLegacy'],
    ]
    for (const [f, name] of legacy) {
      const src = read(f)
      const b = src.indexOf(`heal-legacy-path:begin ${name}`)
      const e = src.indexOf(`heal-legacy-path:end ${name}`)
      expect([f, b > -1, e > b]).toEqual([f, true, true])
      // Outside the legacy region the file carries no forbidden token beyond the flag switch.
      const outside = (src.slice(0, b) + src.slice(e)).replace(/^import .*$/gm, '')
      expect([f, countForbidden(outside)]).toEqual([f, {}])
    }
  })
})

// ---------------------------------------------------------------- (B) seam isolation

/** Violations of the in-heal rules for one file (pure so a fixture can prove it). */
function healFileViolations(file: string, src: string): string[] {
  const c = stripComments(src)
  const v: string[] = []
  const bad: Array<[string, RegExp]> = [
    ['capacity picker', /\bpickSessionTarget\b/],
    ['supervisor frame sender', /\bsendToSupervisor\b/],
    ['online agent lister', /\blistOnlineAgentSessionsForUser\b/],
    ['launch call', /\blaunchSessionForUser\s*\(/],
    ['orchestrator-enabled predicate', /\bisOrchestratorEnabled\b|REMO_ORCHESTRATOR_ENABLED/],
    ['session-start literal', /['"`]session\.start['"`]/],
    ['ensure-online hook', /\bensureOnline\w*|ensure-online hook\s*[:=(]/],
    ['interval timer', /\bsetInterval\b/],
  ]
  for (const [label, re] of bad) if (re.test(c)) v.push(`${file}: ${label}`)
  if (file !== 'heal/route.ts') {
    if (/gates:\s*\[/.test(c)) v.push(`${file}: gates literal outside route.ts`)
    if (/(^|[^A-Za-z0-9_$])dispatch\s*\(/.test(c) || /\bdeps\.dispatch\s*\(/.test(c)) v.push(`${file}: dispatch call outside route.ts`)
    if (/\bcounterKey\s*\??\s*:|\.counterKey\s*=[^=]|[{,]\s*counterKey\s*[,}]/.test(c)) v.push(`${file}: lifetime key assigned outside route.ts`)
  }
  if (!['heal/config.ts', 'heal/flag.ts'].includes(file) && (/REMO_HEAL/.test(c) || /process\.env/.test(c))) {
    v.push(`${file}: env read outside config.ts/flag.ts`)
  }
  if (file !== 'heal/autospawn-deps.ts' && /\blaunchSessionForUser\b/.test(c)) v.push(`${file}: launch primitive named outside autospawn-deps.ts`)
  return v
}

describe('SC1 (B): hub/src/heal is the single seam and owns nothing it should not', () => {
  test('SELF-CHECK: the heal tree is found (route.ts, config.ts, flag.ts, sources/*)', () => {
    for (const f of ['heal/route.ts', 'heal/config.ts', 'heal/flag.ts', 'heal/types.ts', 'heal/autospawn-deps.ts']) {
      expect([f, HEAL.includes(f)]).toEqual([f, true])
    }
    expect(HEAL.filter((f) => f.startsWith('heal/sources/')).length).toBe(4)
  })

  test('no heal module violates the seam isolation rules', () => {
    const v = HEAL.flatMap((f) => healFileViolations(f, read(f)))
    expect(v).toEqual([])
  })

  test('PROOF: each isolation rule trips on a violating fixture', () => {
    const cases: Array<[string, string, string]> = [
      ['heal/x.ts', 'pickSessionTarget(a)', 'capacity picker'],
      ['heal/x.ts', 'sendToSupervisor(a, b)', 'supervisor frame sender'],
      ['heal/x.ts', 'listOnlineAgentSessionsForUser(u)', 'online agent lister'],
      ['heal/x.ts', 'await launchSessionForUser(a)', 'launch call'],
      ['heal/x.ts', 'if (isOrchestratorEnabled()) {}', 'orchestrator-enabled predicate'],
      ['heal/x.ts', "send({ type: 'session.start' })", 'session-start literal'],
      ['heal/x.ts', 'await ensureOnline(s)', 'ensure-online hook'],
      ['heal/x.ts', 'setInterval(f, 10)', 'interval timer'],
      ['heal/x.ts', 'const p = { gates: [a] }', 'gates literal outside route.ts'],
      ['heal/x.ts', 'await deps.dispatch(req)', 'dispatch call outside route.ts'],
      ['heal/x.ts', 'const r = { counterKey: k }', 'lifetime key assigned outside route.ts'],
      ['heal/x.ts', "const v = process.env.REMO_HEAL_X", 'env read outside config.ts/flag.ts'],
      ['heal/x.ts', "import('../telegram/launch.ts').then((m) => m.launchSessionForUser)", 'launch primitive named outside autospawn-deps.ts'],
    ]
    for (const [file, src, label] of cases) {
      expect([label, healFileViolations(file, src).some((m) => m.includes(label))]).toEqual([label, true])
    }
    expect(healFileViolations('heal/x.ts', '// pickSessionTarget( setInterval( gates: [\nconst ok = 1')).toEqual([])
  })

  test('exactly one gates literal exists under hub/src/heal and it is in route.ts', () => {
    const files = HEAL.filter((f) => /gates:\s*\[/.test(code(f)))
    expect(files).toEqual(['heal/route.ts'])
    expect((code('heal/route.ts').match(/gates:\s*\[/g) ?? []).length).toBe(1)
  })

  test('every dispatch call goes through the injected dependency of the single pipeline builder', () => {
    const c = code('heal/route.ts')
    const calls = [...c.matchAll(/(^|[^A-Za-z0-9_$])(?:deps\.)?dispatch\s*\(/g)]
    expect(calls.length).toBeGreaterThanOrEqual(3) // live, launch park, replay re-entry
    const lines = c.split(/\r?\n/).filter((l) => /(^|[^A-Za-z0-9_$.])dispatch\s*\(/.test(l) || /deps\.dispatch\s*\(/.test(l))
    for (const l of lines) {
      const ok = /deps\.dispatch\s*\(/.test(l) || /^\s*dispatch\(req: DispatchRequest/.test(l)
      expect([l.trim(), ok]).toEqual([l.trim(), true])
    }
    // The pipeline builder is a single function that owns the gate list.
    expect((c.match(/function buildPipelineDeps\b/g) ?? []).length).toBe(1)
    // The real dependency binding is the imported pipeline dispatch, nothing hand-rolled.
    expect(c).toMatch(/import \{ dispatch,/)
  })

  test('the lifetime key is assigned in route.ts only, from the shared builder', () => {
    const assign = [/\bcounterKey\s*\??\s*:/, /\.counterKey\s*=[^=]/, /[{,]\s*counterKey\s*[,}]/]
    const files = HEAL.filter((f) => code(f).split(/\r?\n/).some((l) => assign.some((re) => re.test(l))))
    expect(files).toEqual(['heal/route.ts'])
    const lines = code('heal/route.ts').split(/\r?\n/).filter((l) => assign.some((re) => re.test(l)))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const l of lines) {
      const ok = /buildHealKey\(/.test(l) || /req\.counterKey/.test(l)
      expect([l.trim(), ok]).toEqual([l.trim(), true])
    }
    expect(read('heal/counter-key.ts')).toContain('export function buildHealKey')
  })

  test('REMO_HEAL env is read only in config.ts and flag.ts across all of hub/src', () => {
    const readers = ALL.filter((f) => /REMO_HEAL_/.test(code(f)))
    expect(readers.sort()).toEqual(['heal/config.ts', 'heal/flag.ts'])
    expect(HEAL.filter((f) => /process\.env/.test(code(f))).sort()).toEqual(['heal/config.ts', 'heal/flag.ts'])
  })

  test('route.ts launches only through governedLaunch (no direct primitive)', () => {
    const c = code('heal/route.ts')
    expect(c).toMatch(/import \{ governedLaunch \} from '\.\.\/dispatch\/governed-launch\.ts'/)
    expect(c).toMatch(/\bgovernedLaunch\(/)
    expect(c).not.toMatch(/\blaunchSessionForUser\b/)
  })

  test('governed-launch.ts carries no session-start literal and no interval timer', () => {
    const c = code('dispatch/governed-launch.ts')
    expect(c).not.toMatch(/['"`]session\.start['"`]/)
    expect(c).not.toMatch(/\bsetInterval\b/)
  })
})

// ---------------------------------------------------------------- (C) positive wiring

describe('SC1 (C): each source reads the flag before it reaches routeHeal', () => {
  const firstIdx = (c: string, re: RegExp) => c.search(re)

  test.each([
    ['api/coolify-webhook.ts', /routeHeal\(/],
    ['error-capture/dispatcher.ts', /routeHeal\(/],
    ['feedback/dispatcher.ts', /routeHeal\(/],
    ['scheduler/dispatcher.ts', /healFailedScheduledRun\(/],
  ])('%s checks healUnifiedEnabled() before %p', (file, reach) => {
    const c = code(file as string)
    const flag = firstIdx(c, /healUnifiedEnabled\(\)/)
    const target = firstIdx(c, reach as RegExp)
    expect(flag).toBeGreaterThan(-1)
    expect(target).toBeGreaterThan(flag)
  })

  test('the scheduled-task source reaches routeHeal and is the only scheduler path into heal', () => {
    expect(code('heal/sources/scheduled-task.ts')).toMatch(/\brouteHeal\(/)
    const schedulerFilesNamingHeal = ALL.filter((f) => f.startsWith('scheduler/') && /heal\//.test(code(f)))
    expect(schedulerFilesNamingHeal).toEqual(['scheduler/dispatcher.ts'])
  })

  test('routeHeal is exported from route.ts with HealEvent and HealOutcome exported from types.ts', () => {
    expect(code('heal/route.ts')).toMatch(/export async function routeHeal\(/)
    const t = code('heal/types.ts')
    expect(t).toMatch(/export type HealEvent\b/)
    expect(t).toMatch(/export type HealOutcome\b/)
  })

  test('SH-02: no `as any` in the source builders; no HealEvent cast at the call sites', () => {
    for (const f of ALL.filter((x) => x.startsWith('heal/sources/'))) {
      expect([f, /\bas any\b/.test(code(f))]).toEqual([f, false])
    }
    for (const f of ['api/coolify-webhook.ts', 'error-capture/dispatcher.ts', 'feedback/dispatcher.ts']) {
      expect([f, /\bas HealEvent\b/.test(code(f))]).toEqual([f, false])
    }
  })
})

// ---------------------------------------------------------------- SH-06: dead legacy machinery stays dead

describe('SH-06: the legacy triage pending map and its hook cannot return', () => {
  test.each([
    'interface PendingTriage',
    'function onTriageAssistantMessage',
    'REMO_TRIAGE_TIMEOUT_MS',
    'new Map<string, PendingTriage>',
    'function _pending',
  ])('hub/src contains no %s', (needle) => {
    const hits = ALL.filter((f) => code(f).includes(needle))
    expect(hits).toEqual([])
  })
})
