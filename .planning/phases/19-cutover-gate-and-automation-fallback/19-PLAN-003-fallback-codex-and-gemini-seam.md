---
phase: 19-cutover-gate-and-automation-fallback
plan: 03
type: execute
wave: 2
depends_on:
  - 19-02
files_modified:
  - supervisor/src/runners/index.ts
  - supervisor/src/runners/gemini-pty-runner.ts
  - supervisor/test/codex-fallback-no-apikey.test.ts
  - supervisor/test/gemini-seam-stub.test.ts
  - supervisor/test/no-apikey-fallback-guard.test.ts
autonomous: true
requirements:
  - R-PTY-23
must_haves:
  truths:
    - "Codex is the PRIMARY fallback: the existing Codex PTY runner is selectable as a human backend through the SAME terminal surface, using ChatGPT-subscription sign-in (NOT an API key)"
    - "A FUTURE Gemini runner seam exists as a stub only — feature-flagged off / not-implemented, never default-selected (Gemini individual/Pro/Ultra tiers sunset June 18 2026; not reliable)"
    - "NO fallback path constructs an ANTHROPIC_API_KEY env or any API-platform billing call"
  artifacts:
    - path: "supervisor/src/runners/gemini-pty-runner.ts"
      provides: "stubbed/feature-flagged Gemini runner seam (interface placeholder, not a working backend)"
  key_links:
    - from: "backend-selector 'codex' fallback"
      to: "supervisor/src/runners/codex-pty-runner.ts on the shared PTY surface"
      via: "backend-agnostic runner registry (cliKind)"
      pattern: "resolveHumanBackend -> codex-pty-runner (ChatGPT sign-in, no API key)"
---

<objective>
Wire the "If PTY fails" fallback as a backend-CLI swap on the same PTY surface — Codex primary
(subscription sign-in, no API key), a stubbed Gemini seam for the future — and guard that NO path ever
reaches an API key.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/19-cutover-gate-and-automation-fallback/19-CONTEXT.md
@.planning/phases/19-cutover-gate-and-automation-fallback/19-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@supervisor/src/runners/types.ts
@CLAUDE.md
</context>

<threat_model>
- **T-19-03 — API-key fallback creeps in (CRITICAL).** The constraint-1 violation: a fallback path
  passes `ANTHROPIC_API_KEY` (or an OpenAI API key) to bill via the API platform. Mitigation: Codex
  fallback uses ChatGPT-subscription sign-in only; both runners keep the `delete env.ANTHROPIC_API_KEY`
  posture; a NEGATIVE guard test asserts no fallback path builds an API-key env / API call. Block on:
  CRITICAL.
- **T-19-04 — Gemini stub mistaken for a working backend (MED).** Selecting Gemini would fail at runtime
  (or worse, partially work on a sunsetting tier). Mitigation: the Gemini runner is feature-flagged off
  / throws not-implemented and is NEVER default-selected; a test asserts it is never returned by the
  selector and that selecting it explicitly surfaces a clear not-available error.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Wire Codex as the primary human-backend fallback (no API key)</name>
  <files>supervisor/src/runners/index.ts, supervisor/test/codex-fallback-no-apikey.test.ts</files>
  <read_first>
    - supervisor/src/runners/codex-pty-runner.ts (Phase-17 Codex PTY runner)
    - supervisor/src/runners/backend-selector.ts (19-02)
  </read_first>
  <acceptance_criteria>
    - Selecting 'codex' as the human backend spawns the Codex PTY runner on the same terminal surface (backend-agnostic relay)
    - The Codex path uses ChatGPT-subscription sign-in; it constructs NO API-platform/API-key call
    - A test asserts the Codex human-session path is selectable and that no API-key env is set on its spawn
  </acceptance_criteria>
  <action>
    Wire the registry so the selector's 'codex' result routes to the existing Codex PTY runner. Smallest
    diff — the runner already exists (Phase 17).
  </action>
  <verify>
    <automated>cd supervisor; bun test test/codex-fallback-no-apikey.test.ts 2>$null</automated>
  </verify>
  <done>Codex is a working, API-key-free human-backend fallback on the shared surface.</done>
</task>

<task type="auto">
  <name>Task 2: Stubbed Gemini runner seam</name>
  <files>supervisor/src/runners/gemini-pty-runner.ts, supervisor/test/gemini-seam-stub.test.ts</files>
  <read_first>
    - supervisor/src/runners/types.ts (runner interface to conform to)
    - .planning/phases/19-cutover-gate-and-automation-fallback/19-RESEARCH.md (Gemini sunset)
  </read_first>
  <acceptance_criteria>
    - A `gemini-pty-runner.ts` conforms to the runner interface but is feature-flagged OFF / throws a clear "Gemini backend not available" not-implemented error
    - The selector never returns Gemini by default; explicit selection surfaces the not-available error
    - A header comment documents WHY (June-18-2026 tier sunset → Antigravity weekly quotas; re-verify before real wiring)
  </acceptance_criteria>
  <action>
    Author the stub conforming to the runner interface so a future viable backend slots in. Do not
    implement a real Gemini integration.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/gemini-seam-stub.test.ts 2>$null</automated>
  </verify>
  <done>The abstraction holds for a third backend; Gemini is a safe, off-by-default seam.</done>
</task>

<task type="auto">
  <name>Task 3: No-API-key fallback guard</name>
  <files>supervisor/test/no-apikey-fallback-guard.test.ts</files>
  <read_first>
    - supervisor/src/runners/* (all runner spawn paths)
  </read_first>
  <acceptance_criteria>
    - A guard test asserts no runner spawn path (claude / codex / gemini-stub / selector) sets ANTHROPIC_API_KEY or constructs an API-platform billing call
    - The Claude runner retains `delete env.ANTHROPIC_API_KEY`
  </acceptance_criteria>
  <action>
    Author a grep-style + behavioral guard over the runner spawn paths. Mirror the existing
    no-legacy-agent-spawn canary-test posture.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/no-apikey-fallback-guard.test.ts 2>$null</automated>
  </verify>
  <done>The no-API-key invariant is regression-locked across all fallback paths.</done>
</task>

</tasks>

<verification>
- Codex selectable on the shared surface, no API key
- Gemini stub off by default, not-implemented on explicit select
- no runner path sets ANTHROPIC_API_KEY / builds an API call (guard)
- `bun run check-baseline` green
</verification>

<success_criteria>
The fallback is a backend-CLI swap (Codex primary, Gemini stubbed) on the same PTY surface, with the
no-API-key invariant guarded across every runner path.
</success_criteria>

<output>
Create `.planning/phases/19-cutover-gate-and-automation-fallback/19-03-SUMMARY.md` (re-verify Codex
subscription inclusion + Gemini sunset facts at execution time; record the selector→runner wiring).
</output>
