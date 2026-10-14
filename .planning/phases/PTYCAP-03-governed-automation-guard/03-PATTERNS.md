# Phase 3: Governed-Automation Guard - Pattern Map

**Mapped:** 2026-10-07
**Files analyzed:** 22 (2 new src/test pairs + modifications)
**Analogs found:** 22 / 22 (all paths below are git-tracked source under hub/ or supervisor/)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `hub/src/dispatch/governed-pty.ts` (NEW) | gate module + env flag reader | request-response | `hub/src/dispatch/gates.ts` (L173-312, L458-500) + `orchestrator/controller.ts` L56-70 | exact |
| `hub/src/dispatch/gates.ts` (MOD) | gate lib | request-response | self (`isTokenCapExplicitlyDisabled` L173-177) | exact |
| `hub/src/dispatch/pty-preflight.ts` (MOD, `runChain` L170-184 only) | chain runner | request-response | self | exact |
| `hub/src/ask/dispatch.ts` L131-143, `hub/src/work/dispatch.ts` L293-306 | call site | request-response | self | exact |
| `hub/src/telegram/dispatch.ts` L79, L161-176 | call site | request-response | self | exact |
| `hub/src/api/telegram-webhook.ts` L390 | caller | request-response | self | exact |
| `docs/usage-cost.md`, `CLAUDE.md`, `hub/src/api/_openapi.ts` (L847, L1057), `web/src/lib/termRefusal.ts` | docs/config | - | self | exact |
| `hub/test/governed-pty-gate.test.ts` (NEW) | test (DB-free gate + differential) | request-response | `hub/test/pty-preflight.test.ts` L19-94 | exact |
| `hub/test/pty-door-guard.test.ts` (NEW) | test (static ALLOWED-set + canary) | file-I/O scan | `human-interactive-flag-guard.test.ts` + `token-cap-coverage.test.ts` + `automation-routing-guard.test.ts` L55-79 | exact (3 analogs) |
| `hub/test/term-relay-human-guard.test.ts` (MOD) | test (/ws/client frame) | event-driven | self L15-118 / `ws-client-pty-preflight.test.ts` L14-118 | exact |
| `hub/test/{human-only-guard,telegram-human-only-guard,ext-ask-gates,ext-work-containment}.test.ts` (MOD) | tests | - | self (rename `humanOnlyPtyGate`/`human_only_pty` -> new names) | exact |
| `hub/test/pty-preflight.test.ts` (MOD) | test | request-response | self L96-126 | exact |
| `hub/test/human-interactive-flag-guard.test.ts` (MOD) | test | file-I/O scan | self L37 | exact |

## Pattern Assignments

### `hub/src/dispatch/governed-pty.ts` (NEW)

**Analog A - gate shape + closure-resolved actor:** `hub/src/dispatch/gates.ts` L458-500 (to be REMOVED/replaced; copy structure)
```typescript
export const AUTOMATION_ACTORS: ReadonlySet<string> = new Set([
  'scheduler','orchestrator-background','auto-dev','error-capture','agent',
])
export function humanOnlyRejectsActor(actor: string, runnerType: string): boolean {
  if (runnerType !== 'pty-interactive') return false
  return actor !== 'human'
}
export function humanOnlyPtyGate(
  resolveActorAndRunnerType: (req: DispatchRequest) => Promise<{ actor: string; runnerType: string }>,
): DispatchGate {
  return {
    name: 'human_only_pty',
    async check(req: DispatchRequest) {
      const { actor, runnerType } = await resolveActorAndRunnerType(req)
      if (humanOnlyRejectsActor(actor, runnerType)) {
        return { ok: false, reason: `automation_blocked_on_pty:${actor}` }
      }
      return { ok: true }
    },
  }
}
```
New gate: same signature, `name: 'governed_automation_pty'`. Decision order (D-04/D-06/D-17): non-PTY runner -> ok; actor `human` -> ok; flag OFF -> legacy block `automation_blocked_on_pty:${actor}` (byte-identical); actor not in `AUTOMATION_ACTORS` (incl. external-ask/external-work/unknown) -> same block even with flag ON; then run governors (fixed order kill_switch, token_cap, inject_rate, lifetime_counter), block `automation_blocked_on_pty:${actor}:${governorReason}`. Keep `AUTOMATION_ACTORS`, `humanOnlyRejectsActor` in gates.ts (D-05) - import them.

**Analog B - call-time flag reader** (`hub/src/orchestrator/controller.ts` L67-70; also L56-59):
```typescript
export function isOrchestratorEnabled(): boolean {
  const raw = (process.env.REMO_ORCHESTRATOR_ENABLED ?? '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
```
Copy as `governedAutomationEnabled()` reading `REMO_GOVERNED_AUTOMATION_PTY`; garbage = OFF.

**Analog C - governor gate bodies / reasons / enabled test:**
- inject-rate disabled test `gates.ts` L301-311: `const cap = maxInjectsPerHour(); if (!Number.isFinite(cap) || cap <= 0) return {ok:true}`. Governed chain must INVERT this for the enabled rule: cap<=0/non-finite -> block `governor_unconfigured:inject_rate` (reuse exported `maxInjectsPerHour()` L284).
- token cap: add next to `isTokenCapExplicitlyDisabled()` (L173-177, private):
```typescript
export function isDailyTokenCapEnforced(): boolean { return !isTokenCapExplicitlyDisabled() }
```
 -> block `governor_unconfigured:token_cap` when false. "Over the limit" stays with `dailyTokenCapGate` / `sessionInjectRateGate` in `PTY_AUTOMATION_TURN_GATES`.
- fail-closed slot bodies: `kill_switch`, `lifetime_counter` return `{ ok:false, reason:'governor_not_implemented:<name>' }`.

**Analog D - test-only DI setter** (`pty-preflight.ts` L49-52):
```typescript
let timeoutMs = 5_000
/** Test-only - shorten the fail-closed timeout. */
export function _setPtyPreflightTimeoutForTests(ms: number): void { timeoutMs = ms }
export function _resetPtyPreflightTimeoutForTests(): void { timeoutMs = 5_000 }
```
Copy as `_setGovernorsForTests(list)` / `_resetGovernorsForTests()`; module-level `let governors = DEFAULT`. No public `governors` param (D-02).

**Closed union / gate factory precedent:** `askRateGate(apiKeyId)`, `workRateGate(userId)` (gates.ts L326-373) - exported `DispatchGate` objects with `name` + `check`.

### `hub/src/dispatch/pty-preflight.ts` - `runChain` automation branch only (D-07)

**Current code (L170-184) to modify:**
```typescript
const human = input.actor === 'human'
const req: DispatchRequest = { userId, sessionId, token: `pty-preflight:${input.sessionId}`, prompt: '',
  ...(human ? { humanInteractive: true as const } : {}), }   // L177 line pinned verbatim by human-interactive-flag-guard
for (const gate of human ? PTY_HUMAN_TURN_GATES : PTY_AUTOMATION_TURN_GATES) {
  const result = await gate.check(req)
  if (!result.ok) return { ok: false, reason: result.reason }
}
```
Change only the loop iterable to `human ? PTY_HUMAN_TURN_GATES : [...PTY_AUTOMATION_TURN_GATES, ...governedAutomationGovernors()]`. DO NOT touch L34 literal or L41-43 filter (D-07 trap; token-cap-coverage scans the L34 literal and needs both caps; a variable list is invisible to it). Flag check FIRST in the automation branch (before any DB gate). Thrown/timeout already handled by `checkPtyTurnPreflight` L196-214 (`pty_preflight_error`/`pty_preflight_timeout`) - D-14, no new code.

### Call sites (rename + `source`)

`hub/src/ask/dispatch.ts` L131-143 (same shape at `work/dispatch.ts` L293-306):
```typescript
humanOnlyPtyGate(async (req) => {
  const rows = await sql<{ runner_type: string }[]>`SELECT runner_type FROM sessions WHERE id = ${req.sessionId} LIMIT 1`
  // The actor is SERVER-INFERRED from the api_key - never client-asserted.
  return { actor: EXT_ACTOR, runnerType: rows[0]?.runner_type ?? 'stream-json' }
}),
```
Swap identifier + import (ask L32, work L33, telegram L47). Also fix comments at ask L13/L129, work L7/L11, ext.ts L230, ext-api-key-middleware L13/L29, client.ts L171.

`hub/src/telegram/dispatch.ts`: L79 `source?: TelegramDispatchSource;` -> required; L161 delete `?? "human"` default:
```typescript
const source: TelegramDispatchSource = input.source ?? "human";   // L161 -> const source = input.source
```
`telegram-webhook.ts` L390 `dispatchToSession({userId,sessionId,chatId,updateId,text,images})` add `source: 'human'` literal. L183 (`await dispatchToSession(input)`) is the replay; passes through the already-typed input. Reason-prefix mapper at ~L218-227 matches by prefix - append-only reasons are safe (D-08).

### `hub/test/governed-pty-gate.test.ts` (NEW) - DB-free gate test

**Analog:** `hub/test/pty-preflight.test.ts` L19-94. Copy verbatim: JWT env line, `state` object, leaf `mock.module` calls for `usage/threshold.ts`, `usage/store.ts`, `db/postgres.ts`, `db/token-usage-dal.ts`, `db/orchestrator-rows-dal.ts`, then:
```typescript
const modUrl = `../src/dispatch/pty-preflight.ts?t=${Date.now()}${Math.random()}`
const { checkPtyTurnPreflight, _setPtyPreflightTimeoutForTests, _resetPtyPreflightTimeoutForTests } = await import(modUrl)
const { sessionInjectRateGate } = await import('../src/dispatch/gates.ts')
beforeEach(() => { /* reset state + env flags + _resetGovernorsForTests() + _resetPtyPreflightTimeoutForTests() */ })
```
Cover: eligible-actor matrix (external-ask/external-work/unknown denied with flag ON + all governors passing via `_setGovernorsForTests`); production slots fail closed `governor_not_implemented:*`; order; `governor_unconfigured:*` (set `REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR=0`, `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED=1`); thrown/hung governor -> `pty_preflight_error`/`pty_preflight_timeout` (pattern: `state.thresholdMode` 'throw'|'hang' L32-47). Differential test: frozen copy of legacy `humanOnlyRejectsActor`+reason as oracle over (actor x runnerType) matrix with flag OFF. Restore env in afterEach (flag is call-time).
Must be DB-free; add no `describe.skip` (baseline skip=259/260, D-13).

### `hub/test/pty-door-guard.test.ts` (NEW) - structural pins

**Analog 1 (ALLOWED-set walk)** `human-interactive-flag-guard.test.ts` L8-33:
```typescript
const SRC = join(import.meta.dir, '..', 'src')
const ALLOWED = new Set(['dispatch/pipeline.ts', 'dispatch/gates.ts', 'dispatch/pty-preflight.ts'])
function walk(dir: string): string[] { return readdirSync(dir).flatMap((name) => {
  const p = join(dir, name)
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [] }) }
const offenders = walk(SRC).filter((f) => readFileSync(f,'utf8').includes('humanInteractive'))
  .map((f) => relative(SRC, f).split('\\').join('/')).filter((f) => !ALLOWED.has(f))
expect(offenders).toEqual([])
```
Use for: hub->agent `term.*` emitters (expected today: `ws/client.ts`, `telegram/transcript/pty-inject.ts`; `ws/term-protocol.ts` only declares schemas - exclude it explicitly), `actor: 'automation'` callers, `actor: 'human'` preflight callers (`ws/client.ts` only), `injectPtyKeystroke(` (def `pty-inject.ts` L34; caller `api/telegram-webhook.ts` L556), `dispatchToSession(` (webhook L390 + `telegram/dispatch.ts` L183 replay), env name `REMO_GOVERNED_AUTOMATION_PTY` (only `dispatch/governed-pty.ts`).

**Analog 2 (scanner self-check, cannot pass vacuously)** `token-cap-coverage.test.ts` L77-94:
```typescript
test('at least the known dispatchers are present (the scan actually found them)', () => {
  const files = new Set(gateLists().lists.map((g) => g.file))
  for (const expected of [ ... ]) { expect(files.has(expected)).toBe(true) }
})
```
Assert the emitter scan FINDS both expected files. Also fail on a scanner that cannot parse (L73-75 `unparsed` toEqual([]) pattern). Note: any new `gates: [` literal must include both caps (L96-101); prefer not adding one.

**Analog 3 (static read of supervisor source from hub/test)** `automation-routing-guard.test.ts` L55-67:
```typescript
const runnersDir = join(import.meta.dir, '..', '..', 'supervisor', 'src', 'runners')
const src = readFileSync(join(runnersDir, f), 'utf-8')
```
Canary: read `supervisor/src/runners/session-bridge.ts`; slice the `msg.type === 'user_message'` block (L444-465) and `permission_response` block (L466+) and assert neither contains `ptyRunner`/`ensurePtyRunner`/`pty?.write`/`pty.write`. Self-check that the slices are non-empty and that `term.input` branch (L396-402) DOES contain `pty?.write` (non-vacuous). Use `/\r?\n/` splits (Windows CRLF).

### `hub/test/term-relay-human-guard.test.ts` (MOD) - /ws/client extra-keys frame

**Analog:** self L52-78 (`humanClient()`), L101-108 (genuine human forwarded), L110-118 (agent spoof). Add case mirroring L103-107 but with `JSON.stringify({ type:'term.input', session_id: SESSION, bytes: btoa('y\n'), source:'scheduler', actor:'orchestrator-background' })`; assert forwarded frame count 1 and `JSON.parse(fwdClient[0])` has NO `source`/`actor` keys (zod strip, `ws/term-protocol.ts` L24-79 plain `z.object`). Note preflight is mocked `ok:true` here (L37-41), so also assert via `ws-client-pty-preflight.test.ts` pattern (L58-66, `preflightCalls`) that the call is `{userId, sessionId, actor:'human'}` - put that case in `ws-client-pty-preflight.test.ts` L120-126 style if the preflight mock is needed (`input('\r')` helper L91; submit requires Enter).

### Renames in existing tests
- `human-only-guard.test.ts` L72-76 gate name assertion `human_only_pty` -> `governed_automation_pty`.
- `ext-ask-gates.test.ts` L29 name list `'humanOnlyPtyGate'` -> new; `ext-work-containment.test.ts` L240-245 same; `telegram-human-only-guard.test.ts` L79-80 reason substring `automation_blocked_on_pty` still valid. Telegram tests must now pass `source` explicitly.
- `pty-preflight.test.ts` add after L123: human chain contains no governor (names toEqual threshold,daily_token_cap,daily_cost_cap); automation branch includes governors only when flag ON.
- `human-interactive-flag-guard.test.ts` L37: `src.split('\n')` -> `src.split(/\r?\n/)`.

## Shared Patterns

### Fail-closed
`checkPtyTurnPreflight` (`pty-preflight.ts` L196-214): race against `timeoutMs`, `.catch` -> `pty_preflight_error`. All governor failures reuse it.

### Env flag truthiness
`['1','true','yes','on'].includes(raw.trim().toLowerCase())` (`gates.ts` L173-177, `controller.ts` L67-70). Read at call time, never cached.

### Server-inferred actor
Actor only via closure return value (ask L139-140; ws/client.ts L217/L286 literal `'human'`); `DispatchRequest` (`pipeline.ts` L36-48) has no actor/source field. Never read `req.source`/`req.actor` under `hub/src/dispatch/`.

### Test isolation
One process per hub test file (`mock.module` is process-global); cache-bust real-module imports with `?real=${Date.now()}`; spread real module then override (`...realPreflight`).

## No Analog Found
| File | Reason |
|---|---|
| Hub-to-agent `term.*` emitter scanner | No existing scanner for emitters; compose from the three analogs above. Needs a decision on the pattern (`type: 'term.` object literals plus `getChannel(`/`ws.send` co-occurrence) - self-check against the two known emitters is mandatory. |
| Docs sections (PTYCAP Phase 3 in `docs/usage-cost.md`) | Add after the Phase 2 section (L346-480); keep R-PTY-24 supersession strings (read by `hub/test/docs-supersession.test.ts`). Fix L373-377 and L462-465 per D-11. |

## Metadata
**Analog search scope:** hub/src/{dispatch,ws,telegram,ask,work,orchestrator,api}, hub/test, supervisor/src/runners
**Pattern extraction date:** 2026-10-07
**Tracked-source gate:** all analog paths are repo source (hub/, supervisor/); none are .gsd mirrors.
