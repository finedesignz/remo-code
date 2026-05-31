---
phase: 19-cutover-gate-and-automation-fallback
plan: 02
type: execute
wave: 2
depends_on:
  - 19-01
files_modified:
  - supervisor/src/runners/backend-selector.ts
  - supervisor/src/runners/index.ts
  - supervisor/test/default-backend-selector.test.ts
files_modified_note: "exact runner-registry paths = discretion; selector lives where human-session runner choice is made"
autonomous: false
requirements:
  - R-PTY-22
  - R-PTY-22b
  - R-PTY-22c
must_haves:
  truths:
    - "A default-backend selector governs which runner a NEW human session uses, resolving to an EXPLICIT PTY runner ID — `claude-pty` | `codex-pty` — NEVER the bare `claude`/`codex` id and NEVER the legacy stream-json runner"
    - "Human sessions resolve ONLY to a PTY/interactive backend; the legacy stream-json Claude runner is NOT a selectable human backend (it remains exclusively for unattended automation behind the cost cap). The selector HARD-REJECTS (throws) any attempt to resolve a human session to a stream-json/legacy runner id"
    - "Defense-in-depth: the selector itself re-asserts the human-only guard (isHuman===true) AT resolution time, in addition to the relay-boundary guard (Phase-16 H1) — so a mis-routed automation context cannot obtain a human PTY backend, and a human context cannot obtain the legacy runner"
    - "FAIL-SAFE default: until the cutover gate confirms PTY-interactive billing, the default human backend is NOT Claude-PTY (resolves to `codex-pty`) — users are never silently put on a programmatic-billed path"
    - "The flip to Claude-PTY-default is a recorded config change gated on the runbook result — NOT an automatic behavior"
    - "After a FAILED cutover gate, existing Claude-PTY sessions cannot keep leaking to the wrong (programmatic) bucket: on a `programmatic` gate result the Claude-PTY backend is disabled/unlisted (alert + operator override) so neither new nor in-flight human turns route to it"
  artifacts:
    - path: "supervisor/src/runners/backend-selector.ts"
      provides: "default_human_backend resolution + the gated-flip decision record"
  key_links:
    - from: "new human session spawn"
      to: "backend-selector.resolveHumanBackend() -> 'claude-pty' | 'codex-pty' (explicit PTY runner ids only)"
      via: "default_human_backend config gated on the cutover-gate result; legacy stream-json id is unreachable from this path"
      pattern: "confirmedInteractive ? configuredDefault('claude-pty') : 'codex-pty' (fail-safe); throw on any non-PTY/legacy id"
---

<objective>
Wire the default-backend selector so the green-light only flips human sessions onto Claude-PTY-default
AFTER the cutover gate confirms interactive billing. Fail safe until then: do not default users onto a
programmatic-billed path.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/19-cutover-gate-and-automation-fallback/19-CONTEXT.md
@.planning/phases/19-cutover-gate-and-automation-fallback/19-RESEARCH.md
@supervisor/src/runners/types.ts
@CLAUDE.md
</context>

<threat_model>
- **T-19-02 — Silent default onto a programmatic-billed backend (CRITICAL).** If the selector defaults
  new human sessions to Claude-PTY before the gate confirms interactive billing — and Claude-via-PTY
  turns out to bill programmatic — every human session silently drains the credit pool. Mitigation:
  fail-safe — until a recorded `cutover_gate.claude_interactive_confirmed` flag is set, the default is
  NOT Claude-PTY (resolves to `codex-pty`); the flip is an explicit recorded config change, never
  automatic; a negative test asserts the unconfirmed default is not Claude-PTY. Block on: CRITICAL.
- **T-19-02b — Selector falls back to the legacy stream-json runner for a human session (CRITICAL, H8).**
  The pre-replan selector returned a bare `'claude'`/`'codex'` id, which the runner registry could
  resolve to the LEGACY stream-json Claude runner — emitting `--input-format/--output-format` on a human
  turn and billing programmatic. Mitigation: the selector resolves to EXPLICIT PTY runner ids
  (`'claude-pty'`/`'codex-pty'`) ONLY; the legacy/stream-json runner id is NOT in the human-resolvable
  set; `resolveHumanBackend` HARD-REJECTS (throws) any config/flag combination that would yield a
  non-PTY or legacy id. A negative test asserts: (a) no input ever yields the legacy id, (b) a
  config polluted with `'claude'`/`'stream-json'` throws rather than silently downgrading. Block on: CRITICAL.
- **T-19-02c — Automation context obtains a human PTY backend, or a human context obtains the legacy
  runner (HIGH, H8 defense-in-depth).** The relay-boundary guard (Phase-16 H1) is primary, but a
  mis-routed `isHuman=false` context reaching this selector must not produce a PTY backend, and a human
  context must never be downgraded to legacy. Mitigation: `resolveHumanBackend(ctx)` re-asserts
  `ctx.isHuman === true` and throws otherwise (in-selector defense-in-depth, independent of the relay
  guard); a test drives `isHuman:false` and asserts a throw.
- **T-19-02d — In-flight Claude-PTY sessions keep routing to a programmatic bucket after a FAILED gate
  (HIGH, H8/folded).** If the June-15 measurement returns `programmatic`, existing Claude-PTY sessions
  would continue billing wrong on their next human turn. Mitigation: on a `programmatic` gate result the
  Claude-PTY backend is DISABLED/unlisted (selector refuses to return it for new OR existing sessions),
  an alert fires, and only an explicit operator override re-enables it; a test asserts a disabled
  Claude-PTY backend is never returned even when config requests it.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Backend selector with fail-safe default</name>
  <files>supervisor/src/runners/backend-selector.ts, supervisor/src/runners/index.ts</files>
  <read_first>
    - supervisor/src/runners/types.ts (cliKind union; runner registry shape)
    - supervisor/src/runners/index.ts (where a runner is chosen for a session)
  </read_first>
  <acceptance_criteria>
    - `backend-selector.ts` exports `resolveHumanBackend(ctx)` → `'claude-pty' | 'codex-pty'` (EXPLICIT PTY runner ids; NEVER the bare `'claude'`/`'codex'` and NEVER a legacy/stream-json id), reading a config (`default_human_backend`) AND a gate flag (`claude_interactive_confirmed`)
    - HARD REJECT: any config/flag combination that would resolve to a non-PTY or legacy/stream-json runner id THROWS (no silent downgrade). The legacy stream-json runner is unreachable from this function.
    - DEFENSE-IN-DEPTH: `resolveHumanBackend` asserts `ctx.isHuman === true` and THROWS otherwise (independent of the Phase-16 relay-boundary guard).
    - When the gate flag is NOT set, resolve returns the fail-safe `'codex-pty'` regardless of config — never `'claude-pty'` by accident
    - When the flag IS set, resolve honors the configured default (still PTY-only)
    - POST-FAILED-GATE: when the recorded gate result is `programmatic`, the Claude-PTY backend is disabled/unlisted — resolve never returns `'claude-pty'` for new OR existing sessions until an explicit operator override clears it (emits an alert on the disable)
    - The selector governs ONLY human sessions; automation does not use it (automation is stream-json/programmatic and routes through the dispatch pipeline, not this selector)
    - tsc passes
  </acceptance_criteria>
  <action>
    Implement the resolver + the config/flag plumbing (config storage = discretion; the gate flag is a
    recorded value set by the operator after the runbook, NOT auto). Resolve to explicit `*-pty` ids;
    throw on any path that would yield a legacy/non-PTY id or a non-human ctx. Add the
    `programmatic`-result disable/unlist of Claude-PTY (operator-override-clearable, alert on disable).
    Wire the human-session spawn to call it.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/default-backend-selector.test.ts 2>$null</automated>
  </verify>
  <done>Human backend selection is gated + fail-safe.</done>
</task>

<task type="auto">
  <name>Task 2: Fail-safe + gated-flip tests</name>
  <files>supervisor/test/default-backend-selector.test.ts</files>
  <read_first>
    - supervisor/src/runners/backend-selector.ts
  </read_first>
  <acceptance_criteria>
    - Test: gate flag unset ⇒ resolve returns `'codex-pty'`, NEVER `'claude-pty'` even if config says claude (fail-safe, negative)
    - Test: gate flag set + config claude ⇒ resolve returns `'claude-pty'`; gate flag set + config codex ⇒ `'codex-pty'`
    - Test (H8 hard-reject, negative): config polluted with `'claude'`/`'codex'`/`'stream-json'`/any legacy id ⇒ resolve THROWS; assert the legacy stream-json runner id is NEVER a return value for any input
    - Test (H8 defense-in-depth, negative): `ctx.isHuman === false` ⇒ resolve THROWS (no PTY backend handed to automation)
    - Test (H8 post-failed-gate, negative): gate result `programmatic` ⇒ `'claude-pty'` is never returned for new OR existing sessions even when config requests it, until an operator-override flag clears the disable
    - Test: the gate flag is not flipped by any automatic code path (it is operator-set) — assert no production code writes it
    - SELECTOR→SPAWN-ARGV negative test (PARTIAL-binding, H8/NH-adjacent): for EACH backend the selector can return (`'claude-pty'`, `'codex-pty'`), drive the resolved id through the runner registry to its REAL spawn path (reuse the H6 node-pty spawn-interception seam) and assert the spawned argv contains NONE of `-p`/`--print`/`--input-format`/`--output-format`/`stream-json`. This binds the selector's output to the actual argv at the Phase-19 selector seam — not just leaning on the Phase-16/17 canary — so a human-resolved backend can never emit a programmatic flag.
  </acceptance_criteria>
  <action>
    Author the tests; the "no auto-flip" assertion can grep the codebase for writes to the flag and
    assert they are only in operator/config tooling, not the runtime. For the selector→argv test, resolve
    each backend id, instantiate its runner via the real spawn path (intercept node-pty.spawn), and assert
    the intercepted argv carries no programmatic flag.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/default-backend-selector.test.ts 2>$null</automated>
  </verify>
  <done>The fail-safe + gated-flip behavior is regression-locked.</done>
</task>

</tasks>

<verification>
- resolve returns explicit `'claude-pty'`/`'codex-pty'` only; legacy stream-json id never returned for any input (negative)
- hard-reject: legacy/non-PTY config id THROWS; `ctx.isHuman:false` THROWS (defense-in-depth)
- unconfirmed gate ⇒ default = `'codex-pty'`, never `'claude-pty'` (negative)
- confirmed gate ⇒ configured default honored (PTY-only)
- post-`programmatic`-gate ⇒ Claude-PTY disabled, never returned for new/existing until operator override (negative)
- selector→spawn-argv: each resolvable human backend's REAL spawned argv carries no `-p`/`--input-format`/`--output-format`/`stream-json` (intercepted at the Phase-19 selector seam, not only the P16/17 canary)
- flag is operator-set, not auto-flipped
- `bun run check-baseline` green
</verification>

<success_criteria>
New human sessions never silently land on a programmatic-billed backend; Claude-PTY-default is reached
only via a recorded, gate-confirmed config flip.
</success_criteria>

<output>
Create `.planning/phases/19-cutover-gate-and-automation-fallback/19-02-SUMMARY.md` (record the selector
config key + the gate flag location).
</output>
