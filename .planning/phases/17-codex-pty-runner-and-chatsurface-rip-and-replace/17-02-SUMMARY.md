---
phase: 17-codex-pty-runner-and-chatsurface-rip-and-replace
plan: 02
subsystem: web/terminal-routing + tools/one-way-door-gate
tags: [cutover-gate, one-way-door, terminal-surface, deferred]
provides: [cutover-deletion-gate-test]
requires: [phase16-verdict-schema, cutover-deletion-gate]
affects: [web, tools]
key-files:
  created:
    - web/test/cutover-deletion-gate.test.ts
status: PARTIAL — gate enforced; ChatSurface deletion DEFERRED (blocked-on-manual-gate)
metrics:
  completed: 2026-06-01
---

# Phase 17 Plan 02: Rip ChatSurface + Route Terminal — Summary (DELETION DEFERRED)

## Status: gate built + ENFORCED; ChatSurface NOT deleted

Per the Phase-16 one-way-door safeguard, the destructive half of this plan is **blocked**. Phase 16
verified **PARTIAL** — `render_fidelity: FAIL`, `mobile_reattach: FAIL`, and the two
`manual_attestation` triplets (R-PTY-07 phone reattach, R-PTY-09 mobile resize/scrollback) are empty.
`tools/cutover-deletion-gate.mjs` therefore exits non-zero, which by contract aborts the deletion task.

## What was built (Task 1 — the mechanical gate)
- The gate (`tools/cutover-deletion-gate.mjs`) + its shared rule (`tools/phase16-verdict-schema.mjs`)
  already shipped in Phase 16 (commit b7e218c). They fully implement the GATE-PASS RULE: exit 0 ONLY when
  `verdict==PASS` AND `render_fidelity==PASS` AND `mobile_reattach==PASS` AND `automated_suite.result==PASS`
  (+non-empty summary) AND `term_relay_auth.result==PASS` AND each `manual_attestation.<field>` is a
  complete `{by, at, device_build}` triplet (NH-4 anti-forgery).
- **Added the missing enforcement test** `web/test/cutover-deletion-gate.test.ts` per 17-PLAN-002 T1: the
  seven pinned fixtures (a green⇒0; b missing⇒non-zero; c FAIL⇒non-zero; d mobile_reattach absent⇒non-zero;
  e render_fidelity FAIL⇒non-zero; f provenance-absent⇒non-zero; g forged-bare-PASS⇒non-zero) PLUS an
  assertion that the REAL `16-VERIFICATION.md` currently ABORTS. **8 pass / 0 fail.**
- Verified live: `node tools/cutover-deletion-gate.mjs` → exit 1, reasons:
  `verdict=PARTIAL, render_fidelity=FAIL, mobile_reattach=FAIL, render_fidelity_attestation_incomplete, mobile_reattach_attestation_incomplete`.

## Routing (Task 2) — already in place, no change needed
`web/src/components/ChatLayout.tsx` already routes `TerminalSurface` behind the existing
`localStorage remo:pty-interactive` flag (Phase-16 work). The routing seam to the single terminal surface
exists WITHOUT deleting ChatSurface; flipping/removing it is part of the gated deletion. Grid terminal-cells
vs drop-rendering decision is intertwined with the bubble-grid deletion and is therefore deferred with T3.

## Deferred (blocked-on-manual-gate)
- **Task 3 — delete ChatSurface.tsx / ChatSurfaceShowcase.tsx / bubble components / useChatSurface.ts /
  useChat human-bubble logic.** NOT performed. The gate aborts. `no-human-chatsurface.test.tsx` is not
  authored because it would assert the absence of files that intentionally still exist.

## ChatSurface deletion confirmation
**ChatSurface.tsx and all stream-json human chat components remain on disk and intact.** No web/src
component or hook was deleted in this plan.

## Deviations from Plan
- **[Gate] Task 3 deferred, not executed** — mandated by the one-way-door gate (T-17-04/04b) + the explicit
  execution GATE. Recorded as `blocked-on-manual-gate` in 17-VALIDATION.md.
- **[Rule 3] Task 1 gate already existed** — Phase 16 shipped the producer+gate. This plan added only the
  missing fixture test (the deliverable 17-PLAN-002 T1 still owed).

## Self-Check: PASSED
- web/test/cutover-deletion-gate.test.ts exists; 8 pass / 0 fail.
- ChatSurface.tsx still present (grep + ls confirm).
- Commit c8c67c2 present.
