---
phase: 19-cutover-gate-and-automation-fallback
verified: 2026-06-01T00:00:00Z
status: passed
score: 4/4 phase-19 checks verified
verifier: Claude (gsd-verifier, independent source verification)
---

# Phase 19: cutover-gate-and-automation-fallback — Verification Report

**Phase Goal:** Encode the SPEC "Verify after June 15" cutover GATE + wire the "If PTY
fails" backend fallback (Codex primary, Gemini stub), fail-safe so the prod default backend
is unchanged until the gate confirms interactive billing. No API key, ever.

**Status:** PASS (4/4 requested checks verified against source).

## Check Results

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Backend selector behind the flag; PROD DEFAULT UNCHANGED | ✓ VERIFIED | see below |
| 2 | Cutover-deletion-gate ABORTS against current 16-VERIFICATION.md | ✓ VERIFIED | exit 1 |
| 3 | Fallback seam PTY→Codex→Gemini, never an API key; sanitizeSpawnEnv; canary | ✓ VERIFIED | see below |
| 4 | Cost cap + human-only guard composed-with, not bypassed | ✓ VERIFIED | gates.ts |

### Check 1 — selector gated, default unchanged

- `supervisor/src/runners/backend-selector.ts`: `resolveHumanBackend()` is FAIL-SAFE —
  when `gate.claudeInteractiveConfirmed !== true` it returns `'codex-pty'` even when config
  says `'claude'`; a `'programmatic'` gate result DISABLES claude-pty (returns codex-pty +
  alert); non-human ctx throws; legacy/stream-json ids are unreachable (type
  `HumanBackendId = 'claude-pty' | 'codex-pty'`, `FORBIDDEN_HUMAN_IDS` throws).
- **The selector is NOT wired into the live session path.** `supervisor/src/index.ts` only
  re-exports `selectHumanPtyRunner`/`runnerForHumanBackend` (public API surface). The live
  runtime path (`supervisor/src/runners/session-bridge.ts`) chooses the runner via
  `ptyInteractiveEnabled()` → `process.env.REMO_PTY_INTERACTIVE === '1'`. **Flag OFF
  (prod default) → `ensureRunner()` → `ClaudeRunner` (stream-json) — current behavior,
  unchanged.** PTY runner only instantiated when the flag is on.
- **Test proving default-unchanged:** `supervisor/test/default-backend-selector.test.ts`
  → `describe('19-02 fail-safe default (T-19-02)')`:
  - `test('gate flag unset => codex-pty even when config says claude')`
  - `test('never returns claude-pty when unconfirmed, for any config')`
  Plus `describe('19-02 gate flag is operator-set, not auto-flipped')` →
  `test('no production code writes claudeInteractiveConfirmed')` (greps src to prove no
  production code flips the gate). NB: the supervisor is local (not deployed), so this check
  is about the supervisor MSI default, not the prod hub.

### Check 2 — cutover-deletion-gate ABORTS

`node tools/cutover-deletion-gate.mjs .planning/phases/16-.../16-VERIFICATION.md` →
exit **1**, reasons: `verdict=PARTIAL, render_fidelity=FAIL, mobile_reattach=FAIL,
render_fidelity_attestation_incomplete, mobile_reattach_attestation_incomplete`. The gate
correctly refuses the ChatSurface deletion against the current (PARTIAL) Phase-16 verdict.

### Check 3 — fallback seam, no API key

- `supervisor/src/runners/env-sanitize.ts`: single shared `sanitizeSpawnEnv()` —
  named `PROVIDER_KEY_DENYLIST` (ANTHROPIC/OPENAI/GEMINI/GOOGLE keys + `*_SETUP_TOKEN`)
  AND anchored `CREDENTIAL_PATTERNS` (`_API_KEY$`, `_AUTH_TOKEN$`, …). Applied in BOTH
  `claude-pty-runner.ts` (L96) and `codex-pty-runner.ts` (L104); Rust `pty-host.mjs` mirrors it.
- `gemini-pty-runner.ts`: STUB — `GEMINI_BACKEND_ENABLED = false`, `start()` throws
  `GEMINI_NOT_AVAILABLE_MESSAGE`; env built via `sanitizeSpawnEnv`. Never default-selected.
- Fallback chain is a backend-CLI swap on the same PTY surface (claude-pty → codex-pty →
  gemini stub). NO API-key path.
- Canaries present:
  - `supervisor/test/no-api-key-no-streamjson-pty.test.ts`: forbids
    `--input-format/--output-format/--print/stream-json/-p` in every PTY host file;
    asserts API-key tokens only ever appear adjacent to a delete/sanitize; codex PTY uses
    bare interactive `codex` (no `app-server`/`exec`).
  - `supervisor/test/no-apikey-fallback-guard.test.ts`: sanitizer unit + real-spawn-path
    env-clean (incl. inherited + novel pattern var) + static grep canary (no runner builds
    an API-key env literal).

### Check 4 — cost cap + human-only composed, not bypassed

`hub/src/dispatch/gates.ts`: `isOverCostCap`/`dailyCostCapGate` remain the single source of
truth; `humanOnlyPtyGate`/`humanOnlyRejectsActor` reject any non-human actor on the PTY path
and **compose WITH** (never replace) `dailyCostCapGate`. Automation stays cost-capped on the
programmatic path. No bypass introduced.

## QC

`bun run check-baseline` (dummy 32-char JWT_SECRET): **pass=1274 skip=130 fail=0** — within
tolerance, fail=0.

---

_Verified independently against source (SUMMARY claims not trusted). Verifier: Claude._
