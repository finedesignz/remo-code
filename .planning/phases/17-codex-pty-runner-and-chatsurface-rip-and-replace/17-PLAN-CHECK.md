# Phase 17 — Plan Check + Nyquist Verdict

**Checked:** 2026-05-31
**Checker:** orchestrator (gsd-plan-checker subagent unavailable in this agent context — Task nesting not available; manual review against the gsd-plan-checker rubric. `workflow.plan_review_convergence` is now enabled in `.planning/config.json`, so a convergence pass should re-run this check when the GSD CLI/subagents are available.)

## Requirement coverage (R-PTY-12..16 + R-TG-12)

| Req | Covered by | Acceptance is verifiable? |
|-----|-----------|---------------------------|
| R-PTY-12 (Codex interactive/PTY runner) | 17-PLAN-001 (T1 runner, T2 selection, T3 canary+env) | Yes — extended canary + Codex env test + tsc |
| R-PTY-13 (delete stream-json human chat UI) | 17-PLAN-002 (T3 deletion + no-human-chatsurface test) | Yes — static/render assertion + grep + web build |
| R-PTY-14 (remove dead translation; preserve automation) | 17-PLAN-003 (T1 classify+remove+preservation test) | Yes — automation-preservation regression test |
| R-PTY-15 (all human sessions → terminal surface) | 17-PLAN-002 (T2 routing, T3 grid decision) | Yes — render path + web build + manual two-backend smoke |
| R-PTY-16 (stream-json runner preserved for automation) | 17-PLAN-003 (T1 leaves claude-runner/session-bridge untouched; T3 QC) | Yes — runner path unchanged (grep) + baseline + no-indigo green |
| R-TG-12 (explicit Telegram break, Phase-20 docs) | 17-PLAN-003 (T2 markers + module-present test) | Yes — grep markers + bridge-module-exists test |

**No orphan requirements. No plan without a requirement.** (R-TG-12's docs/`docs:sync` clause is owned by
Phase 20 per the requirement text; Phase 17 owns the explicit-break-marker half.)

## Quality-gate checklist (per workflow step 8 rubric)

- [x] PLAN.md files created in phase dir (3 plans, waves 1-2-3)
- [x] Each plan has valid YAML frontmatter (wave, depends_on, files_modified, autonomous, requirements, must_haves)
- [x] Every task has `<read_first>` including the file being modified
- [x] Every task has `<acceptance_criteria>` with source/behavior/CLI assertions (no subjective language)
- [x] `<action>` blocks carry concrete identifiers (file paths to delete, the exact Phase-20 marker comment, classification method, runner-selection branch) without full implementations
- [x] Dependencies correct: 01 (additive Codex runner) → 02 (rip web UI, gated on Phase-16 PASS) → 03 (hub translation removal + Telegram markers)
- [x] Waves assigned for ordered execution
- [x] must_haves derived from the phase goal
- [x] `<threat_model>` present on every plan (security_enforcement=true); CRITICAL/HIGH threats (premature deletion before proven surface, deleting automation-needed translation, cost-cap severed, silent Telegram break, Codex programmatic-flag leak) each mitigated + test-enforced
- [x] Cross-cutting invariants honored: cost-cap source PRESERVED + non-bypassable; schema untouched; stream-json runner path preserved (R-PTY-16); one-way-door sequencing gate enforced; Telegram bridge module not deleted

## Nyquist (validation sampling) verdict

VALIDATION.md present with a per-task verification map, sampling rate, Wave-0 stubs, and manual-only
verifications. The load-bearing risks (one-way-door gate, automation/cost-cap preservation, deletion
completeness, explicit Telegram break) each have a sampling mechanism. The one-way-door gate (no deletion
until Phase-16 verdict PASS) and the automation-preservation regression are correctly flagged as the
gating verifications, with PRESERVE-on-ambiguity as the safe default. **Dimension 8: PASS.**

## Risks / decisions still open for the operator

1. **One-way-door timing (17-02 T1, autonomous:false).** Deletions are permanent within the branch.
   The plan HALTS unless the Phase-16 ship-verdict is PASS. Operator confirms in 17-02-PRECHECK.md.
2. **Translation classification (17-03 T1, autonomous:false).** The human-UI-only vs automation-shared
   boundary is determined by import-graph analysis; ambiguous paths are PRESERVED. Operator reviews the
   classification before removal — deleting automation-needed translation breaks Phase 18 silently.
3. **Interactive Codex CLI argv (17-01).** Codex's interactive entrypoint is undocumented/version-unstable
   (per the Phase-20 Codex note); confirm against the installed version.
4. **Grid decision (17-02 T2).** Terminal-cells vs drop-conversation-rendering — planner's smallest-diff
   choice, recorded in the SUMMARY.
5. **Telegram is non-functional between Phase 17 and Phase 20** — acknowledged + marked, rebuilt on
   transcript-tail in Phase 20.

## Verdict

**PASS — ready for `/gsd:execute-phase 17`** (gated: the deletions in 17-02/03 begin only after the
Phase-16 VERIFICATION verdict is PASS). All six requirements covered with verifiable acceptance criteria,
CRITICAL/HIGH threat models on every plan (one-way-door + automation-preservation treated as the top
boundaries), cost-cap and stream-json-for-automation invariants honored, the Telegram break made explicit
and recoverable, and a Nyquist-compliant validation strategy. The destructive work is isolated behind the
proven-surface checkpoint and PRESERVE-on-ambiguity discipline.

### Cycle-2 addendum (2026-05-31) — H4 closed

**Re-verdict: PASS (strengthened).** SYNTHESIS-cycle1 H4 (one-way-door gate was a narrative note, not
machine-verifiable) is remediated in 17-PLAN-002: Task 1 now specifies a MECHANICAL gate
`tools/cutover-deletion-gate.mjs` that reads the Phase-16 ship-verdict artifact and exits non-zero unless
it records `verdict: PASS` PLUS the manual `render_fidelity: PASS` + `mobile_reattach: PASS` fields (so a
CI-green-but-renders-wrong surface cannot trigger the rip). Task 3 invokes the gate as a HARD precondition
(non-zero ⇒ zero deletions); `web/test/cutover-deletion-gate.test.ts` proves abort on missing/FAIL/
manual-field-absent verdicts. The existing `autonomous:false` operator checkpoint remains as Layer 2.
New requirement: **R-PTY-13b**. No other Phase-17 changes (frontmatter reconciliation = H5 sweep, not
this agent). Dependency note: Phase-16 verification must EMIT the `render_fidelity`/`mobile_reattach`
PASS fields the gate parses (cross-ref H5/Phase-16 — pin exact field names at execution).
