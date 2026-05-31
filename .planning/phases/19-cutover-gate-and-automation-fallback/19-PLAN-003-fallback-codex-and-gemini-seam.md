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
  - supervisor/src/runners/env-sanitize.ts
  - supervisor/test/codex-fallback-no-apikey.test.ts
  - supervisor/test/gemini-seam-stub.test.ts
  - supervisor/test/no-apikey-fallback-guard.test.ts
  - supervisor/test/no-setup-token-on-interactive.test.ts
autonomous: true
requirements:
  - R-PTY-23
  - R-PTY-23b
  - R-PTY-23c
must_haves:
  truths:
    - "Codex is the PRIMARY fallback: the existing Codex PTY runner is selectable as a human backend through the SAME terminal surface, using ChatGPT-subscription sign-in (NOT an API key)"
    - "A FUTURE Gemini runner seam exists as a stub only — feature-flagged off / not-implemented, never default-selected (Gemini individual/Pro/Ultra tiers sunset June 18 2026; not reliable)"
    - "A SINGLE shared env-sanitizer (`env-sanitize.ts`) scrubs a denylist of ALL known provider key envs from EVERY runner spawn (Claude + Codex + Gemini-stub): ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS — and any obvious aliases (e.g. ANTHROPIC_AUTH_TOKEN)"
    - "The scrub catches INHERITED env (vars present in the supervisor's own process.env), not only explicitly-set ones — the sanitizer deletes from the resolved spawn env, so an inherited key cannot leak onto the interactive path"
    - "setup-token-provisioned credentials are PROHIBITED on the interactive path until their billing class is verified — no runner spawn provisions/accepts a setup-token-derived credential on a human PTY turn, and a setup-token is never serialized/persisted to the hub"
  artifacts:
    - path: "supervisor/src/runners/gemini-pty-runner.ts"
      provides: "stubbed/feature-flagged Gemini runner seam (interface placeholder, not a working backend)"
    - path: "supervisor/src/runners/env-sanitize.ts"
      provides: "shared provider-key denylist scrubber applied to every runner spawn env (incl. inherited vars)"
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
- **T-19-03 — API-key fallback creeps in (CRITICAL, broadened by H9).** The constraint-1 violation: a
  fallback path passes a provider API key to bill via an API platform. The prior plan only scrubbed
  `ANTHROPIC_API_KEY`, leaving Codex/Gemini paths able to INHERIT `OPENAI_API_KEY`/`GEMINI_API_KEY`/
  `GOOGLE_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS` from the supervisor's own environment. Mitigation: a
  SINGLE shared `env-sanitize.ts` denylist-scrubs ALL of those (+ aliases) from the resolved spawn env of
  EVERY runner (Claude, Codex, Gemini-stub), so an INHERITED key is deleted, not just an explicitly-set
  one. Codex uses ChatGPT-subscription sign-in only. PER-BACKEND behavioral negative tests assert the
  ACTUAL spawned env (post-merge) contains none of the denylisted vars even when each is pre-seeded into
  `process.env`. Block on: CRITICAL.
- **T-19-03b — setup-token credential on the interactive path (HIGH, H9 folded).** A setup-token-derived
  credential could carry an unverified billing class onto a human PTY turn, or be serialized to the hub.
  Mitigation: no runner spawn accepts/provisions a setup-token credential on the interactive path until
  its billing class is verified; a negative test asserts (a) no human PTY spawn env carries a setup-token
  credential and (b) a setup-token is never serialized/persisted to the hub (stays supervisor-ephemeral).
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
    - The Codex path uses ChatGPT-subscription sign-in; it constructs NO API-platform/API-key call; its spawn env routes through the shared `sanitizeSpawnEnv` (Task 3)
    - A test asserts the Codex human-session path is selectable and that no denylisted API-key env (incl. inherited OPENAI_API_KEY) is set on its spawn
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
  <name>Task 3: Shared multi-provider env-sanitizer + per-backend no-API-key guard (H9)</name>
  <files>supervisor/src/runners/env-sanitize.ts, supervisor/test/no-apikey-fallback-guard.test.ts</files>
  <read_first>
    - supervisor/src/runners/* (ALL runner spawn paths — claude / codex / gemini-stub)
    - the existing `delete env.ANTHROPIC_API_KEY` site (to replace with the shared sanitizer)
  </read_first>
  <acceptance_criteria>
    - `env-sanitize.ts` exports `sanitizeSpawnEnv(baseEnv)` that returns a copy with a DENYLIST removed:
      ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS
      (+ ANTHROPIC_AUTH_TOKEN alias). The denylist is a single exported constant (test imports it).
    - EVERY runner spawn path (Claude PTY, Codex PTY, Gemini stub) resolves its spawn env THROUGH the
      sanitizer; the ad-hoc per-runner `delete env.ANTHROPIC_API_KEY` is replaced by the shared call.
    - INHERITED-env coverage: the sanitizer operates on the RESOLVED spawn env (which includes
      process.env inheritance), so a var present only in the supervisor's process.env is still deleted.
    - PER-BACKEND behavioral negative tests: for Claude, Codex, and the Gemini stub, pre-seed EACH
      denylisted var into `process.env`, instantiate the runner via its real spawn path (intercept
      node-pty.spawn — reuse the H6 spawn-interception seam), and assert the ACTUAL spawned env contains
      NONE of the denylisted vars and constructs no API-platform billing call.
    - A static canary (grep) also asserts no runner builds an API-key env literal, mirroring the
      no-legacy-agent-spawn posture (cheap second layer).
  </acceptance_criteria>
  <action>
    Implement the shared sanitizer + denylist constant; route all runners through it. Author the
    behavioral per-backend tests on the real spawn path (intercept node-pty.spawn). Keep a grep canary.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/no-apikey-fallback-guard.test.ts 2>$null</automated>
  </verify>
  <done>One sanitizer scrubs every provider key (incl. inherited) from every runner spawn; regression-locked per backend.</done>
</task>

<task type="auto">
  <name>Task 4: setup-token prohibition on the interactive path (H9 folded)</name>
  <files>supervisor/test/no-setup-token-on-interactive.test.ts</files>
  <read_first>
    - supervisor/src/runners/* (credential provisioning on human PTY spawn)
    - the hub serialization boundary (what the supervisor sends to the hub)
  </read_first>
  <acceptance_criteria>
    - A negative test asserts no human PTY spawn env carries a setup-token-derived credential (until its billing class is verified)
    - A negative test asserts a setup-token is never serialized/persisted to the hub (stays supervisor-ephemeral) — mirror the OAuth-token never-to-hub posture
  </acceptance_criteria>
  <action>
    Author the guard tests. If the interactive path has no setup-token provisioning today, the test
    locks that absence (it must FAIL if a future change introduces one).
  </action>
  <verify>
    <automated>cd supervisor; bun test test/no-setup-token-on-interactive.test.ts 2>$null</automated>
  </verify>
  <done>setup-token cannot reach the interactive path or the hub until its billing class is verified.</done>
</task>

</tasks>

<verification>
- Codex selectable on the shared surface, no API key
- Gemini stub off by default, not-implemented on explicit select
- shared `sanitizeSpawnEnv` scrubs ANTHROPIC/OPENAI/GEMINI/GOOGLE_API_KEY + GOOGLE_APPLICATION_CREDENTIALS (+ alias) from EVERY runner spawn, including INHERITED process.env vars; per-backend behavioral tests assert the real spawned env (Claude/Codex/Gemini-stub)
- no human PTY spawn carries a setup-token credential; setup-token never serialized to the hub
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
