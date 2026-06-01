---
phase: 19
slug: cutover-gate-and-automation-fallback
status: final
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-31
---

# Phase 19 — Validation Strategy

Gate + fallback-wiring phase. The load-bearing risks are (a) silently defaulting users onto a
programmatic-billed backend before the gate confirms interactive billing, and (b) any fallback path
reaching an API key. The gate measurement itself is operator-recorded (manual, post-June-15). Sampling
biases toward the fail-safe default and the no-API-key invariant.

---

## Test Infrastructure

- `bun test` in `supervisor/` and `hub/` (per-file isolation via `bun run check-baseline`; register new
  test files in `tools/regression-baseline.json` if required).
- A committed runbook + checklist artifact under `docs/` (cutover gate); a test asserts its presence +
  that it references the dual-bucket poll and the four checks.
- No DB schema expected; `docs:sync` only if the selector adds a REST endpoint.

---

## Sampling Rate

- CRITICAL invariants (no API-key fallback anywhere; fail-safe default ≠ Claude-PTY until confirmed):
  100% — each has a positive AND a negative assertion.
- HIGH invariants (Codex selectable via the same surface with no API call; selector flip is gated, not
  auto; R-PTY-24 supersession consistent): one positive + one adversarial test each.
- MED/quality (Gemini stub present + off; runbook references the poll; docs updated): one test each.
- The four billing-classification checks are MANUAL (operator-recorded), not automated — sampled by the
  runbook procedure, not a unit test.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|--------|
| 19-01-01 | 01 | 1 | R-PTY-21 | T-19-01 | runbook encodes the 4 checks + dual-bucket measurement; checklist artifact present | unit | `bun test hub/test/cutover-gate-runbook.test.ts` | ✅ green (7 pass) · 34911c5 |
| 19-02-01 | 02 | 2 | R-PTY-22 | T-19-02 | default human backend ≠ Claude-PTY until confirmed-interactive; flip is gated/recorded, not auto | unit (neg) | `bun test supervisor/test/default-backend-selector.test.ts` | ✅ green (14 pass) · a13db90 |
| 19-03-01 | 03 | 2 | R-PTY-23 | T-19-03 | Codex selectable via same surface; NO API-platform/API-key call constructed | unit | `bun test supervisor/test/codex-fallback-no-apikey.test.ts` | ✅ green (5 pass) · a0c41cb |
| 19-03-02 | 03 | 2 | R-PTY-23 | T-19-04 | Gemini runner stub present, flagged off / not-implemented, never default-selected | unit | `bun test supervisor/test/gemini-seam-stub.test.ts` | ✅ green (5 pass) · a0c41cb |
| 19-03-03 | 03 | 2 | R-PTY-23 | T-19-03 | no fallback path builds ANTHROPIC_API_KEY env / API call (grep-style guard) | unit (neg) | `bun test supervisor/test/no-apikey-fallback-guard.test.ts` | ✅ green (12 pass) · a0c41cb |
| 19-03-04 | 03 | 2 | R-PTY-23 | T-19-03b | no setup-token on the interactive spawn env nor serialized to the hub | unit (neg) | `bun test supervisor/test/no-setup-token-on-interactive.test.ts` | ✅ green (3 pass) · a0c41cb |
| 19-04-01 | 04 | 3 | R-PTY-24, R-PTY-25 | T-19-05 | R-PTY-24 marked superseded consistently; docs sweep covers surface/dual-bucket/gate/rip/no-API-key | unit | `bun test hub/test/docs-supersession.test.ts` | ✅ green (4 pass) · 86ae3a4 |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

The test files above are Wave-0 stubs to author first (fail until impl lands). The runbook +
checklist artifact is a Wave-0 doc artifact shared by plan 01 and referenced by plan 04's docs sweep.

---

## Manual-Only Verifications (the gating items)

1. **The four June-15 billing-classification checks (R-PTY-21/22, gating).** Run on a live post-June-15
   account using the Phase-18 dual-bucket poll: (1) which bucket a PTY interactive `claude` turn bills,
   (2) setup-token vs login, (3) subagents/hooks/MCP residual, (4) login-credential headless
   reclassification (ongoing watch). Operator-recorded; the result sets the default backend.
   `autonomous:false` — the billing classification is too consequential to auto-assert.
2. **Default-on flip** — only after check 1 confirms interactive billing, record the selector flip to
   Claude-PTY-default; if programmatic, set Codex. Reversible by config.
3. **Provider-fact re-verification** — re-confirm Codex subscription inclusion + Gemini sunset/quota +
   Grok status at execution time (all fast-moving, secondary-sourced).

---

## Notes

- The gate is "measure then decide", and the decision is a recorded config change — NOT an automated
  flip. The unit tests guard the SEAM (fail-safe default, no-API-key, Codex selectable, Gemini stubbed),
  not the billing measurement.
- No-API-key is tested as a NEGATIVE assertion across the fallback paths — deliberate, since the whole
  point of the backend-swap fallback is to avoid the API.
- R-PTY-24 supersession is asserted to keep SPEC + ROADMAP + REQUIREMENTS consistent (no silent
  contradiction with Phase 20).

---

## Execution status (2026-06-01)

All four plans BUILT + tested GREEN (commits above). QC gate `bun run check-baseline` (hub,
per-file isolated): **pass=1274 skip=130 fail=0** — within tolerance (fail_max=0). The selector /
fallback / gate / runbook test files all pass in `supervisor/` + `hub/`.

### DEFERRED — blocked on the manual gate (NOT executed, NOT faked)

| Item | Status | Why blocked | Unblock path |
|------|--------|-------------|--------------|
| **Default-on flip** (R-PTY-22) — flip `default_human_backend` to Claude-PTY | `deferred:blocked-on-manual-gate` | Requires the June-15 billing measurement (check 1 = `interactive`), operator-recorded on a live post-June-15 account. Fail-safe default (`codex-pty`) is shipped + active until then. | Run the runbook (`docs/cutover-gate-june15.md` Step A); record `claudeInteractiveConfirmed` + the configured default. |
| **ChatSurface (stream-json) deletion** (Phase-17 rip) | `deferred:blocked-on-manual-gate` | `tools/cutover-deletion-gate.mjs` exits 1 — `16-VERIFICATION.md` has `verdict:PARTIAL`, `render_fidelity:FAIL`, `mobile_reattach:FAIL`, empty attestation triplets. Verified: gate ABORTS today. | Record the two on-device attestation triplets in `16-VERIFICATION.md` (render_fidelity + mobile_reattach: `by`+`at`+`device_build`) and flip verdict→PASS; gate then exits 0. |

The manual billing-classification checks (4) + provider-fact re-verification remain operator-only as
specified (`autonomous:false`). Nothing automatable was deferred.
