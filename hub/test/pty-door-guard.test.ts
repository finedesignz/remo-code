/**
 * PTYCAP Phase 3 -- door pins (`.planning/phases/PTYCAP-03-governed-automation-guard/`).
 *
 * The three call-site gates (cost cap, token cap, governed preflight) are NOT
 * the door. The door is (a) the hub modules that EMIT `term.*` frames toward the
 * agent socket, and (b) the supervisor frame router that decides which inbound
 * frame types reach the PTY. This file pins both, plus every privileged caller
 * (automation actor, human actor, preflight, keystroke injector, Telegram
 * dispatch), the flag / DI literals, the actor-inference facts, and the two
 * human-initiated exemptions -- so a future producer that bypasses the governed
 * preflight fails CI instead of silently opening a second route into a PTY.
 *
 * Precedent: human-interactive-flag-guard.test.ts (allowed-set walk) and
 * token-cap-coverage.test.ts (scanner self-check: cannot pass vacuously).
 *
 * Pins scan raw text INCLUDING comments. If a pin flags a comment-only mention,
 * reword the comment -- never widen an allowlist to accommodate it.
 *
 * DB-free: reads source text only.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CLIENT_TO_HUB_TERM_TYPES } from '../src/ws/term-protocol.ts'
import { EXT_ACTOR, EXT_WORK_ACTOR } from '../src/auth/ext-api-key-middleware.ts'

const SRC = join(import.meta.dir, '..', 'src')
const SUPERVISOR_BRIDGE = join(import.meta.dir, '..', '..', 'supervisor', 'src', 'runners', 'session-bridge.ts')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

const norm = (p: string) => relative(SRC, p).split('\\').join('/')
const FILES = walk(SRC).map((p) => ({ rel: norm(p), text: readFileSync(p, 'utf8') }))
const lines = (t: string) => t.split(/\r?\n/)
const read = (rel: string) => {
  const f = FILES.find((x) => x.rel === rel)
  if (!f) throw new Error(`pty-door-guard: ${rel} not found under hub/src`)
  return f.text
}
const filesMatching = (re: RegExp) => FILES.filter((f) => re.test(f.text)).map((f) => f.rel)
const filesIncluding = (needle: string) => FILES.filter((f) => f.text.includes(needle)).map((f) => f.rel)

// ---------------------------------------------------------------------------
// D-01a: hub -> agent term.* emitters
// ---------------------------------------------------------------------------
const FRAME_TYPES = [...CLIENT_TO_HUB_TERM_TYPES] as string[]
const ALLOWED_EMITTERS = new Set(['ws/client.ts', 'telegram/transcript/pty-inject.ts'])
const AGENT_SEND = /\.ws\.send\(|getChannel\(/

function emitters(): string[] {
  const quoted = FRAME_TYPES.map((t) => new RegExp(`['"\`]${t.replace('.', '\\.')}['"\`]`))
  return FILES.filter((f) => quoted.some((q) => q.test(f.text)) && AGENT_SEND.test(f.text)).map((f) => f.rel)
}

describe('PTYCAP Phase 3 -- exactly two hub modules emit term.* frames to the agent (D-01a)', () => {
  test('frame-type set is derived from CLIENT_TO_HUB_TERM_TYPES and includes the write frames', () => {
    expect(FRAME_TYPES).toContain('term.input')
    expect(FRAME_TYPES).toContain('term.attach_file')
  })

  test('no emitter outside the allowlist', () => {
    const offenders = emitters().filter((f) => !ALLOWED_EMITTERS.has(f))
    expect(offenders).toEqual([])
  })

  test('scanner self-check: it finds BOTH allowed emitters (a broken regex fails, never passes vacuously)', () => {
    const found = new Set(emitters())
    for (const a of ALLOWED_EMITTERS) expect(found.has(a)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D-01b: supervisor routing canary
// ---------------------------------------------------------------------------
function blockFrom(src: string[], startNeedle: string, stopNeedle: string): string {
  const start = src.findIndex((l) => l.includes(startNeedle))
  if (start < 0) throw new Error(`supervisor canary: start line not found: ${startNeedle}`)
  let end = src.length
  for (let i = start + 1; i < src.length; i++) {
    if (src[i].includes(stopNeedle)) { end = i; break }
  }
  return src.slice(start, end).join('\n')
}

describe('PTYCAP Phase 3 -- supervisor never routes user_message / permission_response into the PTY (D-01b)', () => {
  const sup = lines(readFileSync(SUPERVISOR_BRIDGE, 'utf8'))
  const userMessage = blockFrom(sup, "msg.type === 'user_message'", 'msg.type ===')
  const permission = blockFrom(sup, "msg.type === 'permission_response'", 'msg.type ===')
  const termInput = blockFrom(sup, "anyMsg.type === 'term.input'", 'anyMsg.type ===')
  const PTY_TOKENS = ['ensurePtyRunner', 'ptyRunner', 'pty?.write', 'pty.write']

  test('canary self-checks: each slice contains the call it is supposed to contain', () => {
    expect(userMessage).toContain('sendMessage')
    expect(permission).toContain('respondToPermission')
    expect(termInput).toContain('pty?.write')
  })

  test('user_message branch references no PTY runner or PTY write', () => {
    for (const t of PTY_TOKENS) expect(userMessage.includes(t)).toBe(false)
  })

  test('permission_response branch references no PTY runner or PTY write', () => {
    for (const t of PTY_TOKENS) expect(permission.includes(t)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D-01c / D-12 / D-16: privileged caller pins
// ---------------------------------------------------------------------------
describe('PTYCAP Phase 3 -- privileged caller pins (D-01c, D-12, D-16)', () => {
  const AUTOMATION_ACTOR = /actor:\s*['"]automation['"]/
  const HUMAN_ACTOR = /actor:\s*['"]human['"]/

  test('actor "automation" is assigned only under hub/src/orchestrator/ (regex self-checked)', () => {
    expect(AUTOMATION_ACTOR.test("{ actor: 'automation' }")).toBe(true)
    expect(AUTOMATION_ACTOR.test('{ actor: "automation" }')).toBe(true)
    const offenders = filesMatching(AUTOMATION_ACTOR).filter((f) => !f.startsWith('orchestrator/'))
    expect(offenders).toEqual([])
  })

  test('actor "human" is assigned only in ws/client.ts (self-check: it is there)', () => {
    const hits = filesMatching(HUMAN_ACTOR)
    expect(hits).toContain('ws/client.ts')
    expect(hits.filter((f) => f !== 'ws/client.ts')).toEqual([])
  })

  test('checkPtyTurnPreflight( is called only from pty-preflight.ts, ws/client.ts or orchestrator/', () => {
    const hits = filesIncluding('checkPtyTurnPreflight(')
    expect(hits).toContain('ws/client.ts')
    const offenders = hits.filter((f) => f !== 'dispatch/pty-preflight.ts' && f !== 'ws/client.ts' && !f.startsWith('orchestrator/'))
    expect(offenders).toEqual([])
  })

  test('injectPtyKeystroke( appears only in pty-inject.ts and telegram-webhook.ts', () => {
    const allowed = new Set(['telegram/transcript/pty-inject.ts', 'api/telegram-webhook.ts'])
    const hits = filesIncluding('injectPtyKeystroke(')
    for (const a of allowed) expect(hits).toContain(a)
    expect(hits.filter((f) => !allowed.has(f))).toEqual([])
  })

  test('dispatchToSession( appears only in telegram/dispatch.ts and telegram-webhook.ts', () => {
    const allowed = new Set(['telegram/dispatch.ts', 'api/telegram-webhook.ts'])
    const hits = filesIncluding('dispatchToSession(')
    for (const a of allowed) expect(hits).toContain(a)
    expect(hits.filter((f) => !allowed.has(f))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// D-04 / D-02: flag + DI literals
// ---------------------------------------------------------------------------
describe('PTYCAP Phase 3 -- flag and DI literals live only in dispatch/governed-pty.ts (D-04, D-02)', () => {
  for (const literal of ['REMO_GOVERNED_AUTOMATION_PTY', '_setGovernorsForTests']) {
    test(`${literal} appears in hub/src only in dispatch/governed-pty.ts`, () => {
      const hits = filesIncluding(literal)
      expect(hits).toContain('dispatch/governed-pty.ts')
      expect(hits.filter((f) => f !== 'dispatch/governed-pty.ts')).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// D-09 (i): actor is server-inferred, never read from a request
// ---------------------------------------------------------------------------
describe('PTYCAP Phase 3 -- actor is server-inferred (D-09 i)', () => {
  test('nothing under hub/src/dispatch reads a request source/actor field', () => {
    const re = /\b(req|request)\.(source|actor)\b/
    expect(FILES.filter((f) => f.rel.startsWith('dispatch/') && re.test(f.text)).map((f) => f.rel)).toEqual([])
  })

  test('DispatchRequest declares no source/actor member (self-check: the interface body was found)', () => {
    const m = read('dispatch/pipeline.ts').match(/export interface DispatchRequest\s*\{([\s\S]*?)\n\}/)
    expect(m).not.toBeNull()
    const body = m![1]
    expect(body).toContain('userId')
    expect(/\b(source|actor)\??\s*:/.test(body)).toBe(false)
  })

  test('ask and work resolvers return the compile-time actor constants', () => {
    expect(EXT_ACTOR).toBe('external-ask')
    expect(EXT_WORK_ACTOR).toBe('external-work')
    expect(read('ask/dispatch.ts')).toContain('actor: EXT_ACTOR')
    expect(read('work/dispatch.ts')).toContain('actor: EXT_WORK_ACTOR')
  })
})

// ---------------------------------------------------------------------------
// D-09 (iv): Telegram source is required and asserted at the webhook
// ---------------------------------------------------------------------------
describe('PTYCAP Phase 3 -- Telegram dispatch source is required (D-09 iv)', () => {
  test('DispatchInput.source is required and has no human default', () => {
    const src = read('telegram/dispatch.ts')
    expect(src).toContain('source: TelegramDispatchSource;')
    expect(/source\s*\?\?\s*['"]human['"]/.test(src)).toBe(false)
  })

  test('the webhook dispatchToSession call asserts source: "human" at the authenticated boundary', () => {
    const src = read('api/telegram-webhook.ts')
    const start = src.indexOf('dispatchToSession({')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = src.indexOf('});', start)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).toContain('source: "human"')
  })
})

// ---------------------------------------------------------------------------
// D-10: the two human-initiated exemptions, test-pinned with justification
// ---------------------------------------------------------------------------
const EXEMPTIONS: Record<string, string> = {
  injectPtyKeystroke:
    'answers an existing pending permission/question prompt raised by an already-gated turn; one-shot, approver-authorized via takePendingPrompt; a quota check must not wedge a mid-turn prompt',
  'term.attach_file': 'types a file path into the prompt box, never Enter; cannot submit a turn',
}

describe('PTYCAP Phase 3 -- preflight exemptions are explicit and pinned (D-10)', () => {
  test('exactly two exemptions, each with a one-line justification', () => {
    expect(Object.keys(EXEMPTIONS).sort()).toEqual(['injectPtyKeystroke', 'term.attach_file'])
    for (const why of Object.values(EXEMPTIONS)) {
      expect(why.length).toBeGreaterThan(20)
      expect(why.includes('\n')).toBe(false)
    }
  })

  test('injectPtyKeystroke exemption: pty-inject.ts neither calls nor imports the preflight', () => {
    const src = read('telegram/transcript/pty-inject.ts')
    expect(src.includes('checkPtyTurnPreflight')).toBe(false)
    expect(src.includes('pty-preflight')).toBe(false)
  })

  test('term.attach_file exemption: ws/client.ts computes a submit class only for term.input, and preflights only on a submit', () => {
    const src = lines(read('ws/client.ts'))
    const idx = src.findIndex((l) => l.includes('inputClass = classifyPtyInput('))
    expect(idx).toBeGreaterThan(0)
    expect(src[idx - 1]).toContain("if (frame.type === 'term.input')")
    const submitIdx = src.findIndex((l) => l.includes('inputClass?.submit'))
    const preflightIdx = src.findIndex((l) => l.includes('checkPtyTurnPreflight('))
    expect(submitIdx).toBeGreaterThan(-1)
    expect(preflightIdx).toBeGreaterThan(submitIdx)
  })
})
