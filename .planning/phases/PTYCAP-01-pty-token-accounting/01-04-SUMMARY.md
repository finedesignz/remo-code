---
phase: PTYCAP-01-pty-token-accounting
plan: 04
subsystem: usage-cost
tags: [ci, woodpecker, docs, regression-baseline]

requires:
  - phase: PTYCAP-01 plan 01
    provides: "supervisor/test/pty-usage-tail.test.ts, token_usage.runner_type"
  - phase: PTYCAP-01 plan 02
    provides: "hub/test/token-usage-runner-type.test.ts, hub/test/e2e/schema-double-apply.e2e.test.ts CHECK case"
  - phase: PTYCAP-01 plan 03
    provides: "hub/test/pty-usage-midflight-visibility.test.ts, hub/test/no-hub-side-transcript-fs.test.ts, supervisor/test/pty-usage-path-containment.test.ts"
provides:
  - ".woodpecker/qc.yaml — supervisor/test/pty-usage-tail.test.ts now runs as an explicit PR-gate step"
  - "tools/regression-baseline.json — re-measured floor (pass=2059 skip=255 fail=0 total=2314) with a per-file _skip_note_ptycap accounting"
  - "docs/usage-cost.md — PTYCAP Phase 1 accounting-path section, runner_type domain, four recorded deferrals, operator smoke-check item"
  - "CLAUDE.md — Usage cost ledger Docs map row extended to name the PTY source"
affects: [ptycap-phase-2-pty-preflight-gate]

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - .woodpecker/qc.yaml
    - tools/regression-baseline.json
    - docs/usage-cost.md
    - CLAUDE.md

key-decisions:
  - "No production code touched — this plan is CI config + a baseline snapshot + documentation, exactly as planned."
  - "The measured skip delta (247 -> 255, +8) is NOT all PTYCAP's own: 7 are this phase's (6 from pty-usage-midflight-visibility.test.ts, 1 from the new schema-double-apply.e2e.test.ts case), and 1 (hub/test/coolify-webhook-triage-e2e.test.ts) is a pre-existing REMO_E2E_DB_URL-gated skip already on this branch before Phase 1's planning commit, from unrelated scheduler/triage work not authored by PTYCAP. Named explicitly in _skip_note_ptycap rather than silently folded into the phase's own count — the alternative (attributing all 8 to PTYCAP, or absorbing the 1 silently) would misstate either this phase's footprint or the gate's honesty."
  - "pass_min left at 1850 (not raised): actual pass rose to 2059 (~10.2% headroom), comfortably above the ~7% headroom already accepted without raising at the WORK milestone. Raising it further would tighten the floor for no stated reason, which the file's own tolerance _comment warns against as much as leaving it too loose."
  - "docs/usage-cost.md's new index-name reference (idx_token_usage_user_runner_created) reflects what 01-01 actually built, not the idx_token_usage_user_runner_type name guessed in this plan's own read_first — documented what was BUILT, per this task's own instruction to prefer the SUMMARY.md files over plan text on any discrepancy."

patterns-established: []

requirements-completed: [SC-1]

coverage:
  - id: D1
    description: "The SC-1 proof (supervisor/test/pty-usage-tail.test.ts) actually gates the PR in CI, not only a developer's laptop — check-baseline walks hub/test only and never touches supervisor/test."
    requirement: SC-1
    verification:
      - kind: unit
        ref: ".woodpecker/qc.yaml — new `bun test supervisor/test/pty-usage-tail.test.ts` step; QC_YAML_OK grep proves it's wired with no dollar-brace hazard"
        status: pass
    human_judgment: false
  - id: D2
    description: "tools/regression-baseline.json reflects a freshly measured floor-configuration run rather than a stale or guessed snapshot, with fail_max pinned at 0 and every skip delta named and DB-gated."
    requirement: SC-1
    verification:
      - kind: unit
        ref: "bun run check-baseline exits 0 against the rewritten baseline (pass=2059 skip=255 fail=0 total=2314, exact match)"
        status: pass
    human_judgment: false
  - id: D3
    description: "docs/usage-cost.md documents the PTY accounting path, the runner_type domain, and the four planner decisions (P1-D-C/D/E/F) as decisions with reasons, plus the one remaining operator smoke check (01-RESEARCH.md Assumption A2)."
    requirement: SC-1
    verification:
      - kind: unit
        ref: "DOCS_OK grep (pty-interactive + pty-usage-emitter in usage-cost.md, runner_type in CLAUDE.md, no docs/openapi.json or docs/api.md drift)"
        status: pass
    human_judgment: false

duration: ~40min
completed: 2026-07-28
status: complete
---

# Phase 1, Plan 4: Wire SC-1 into CI, Re-measure the Baseline, Document the Path

**The SC-1 proof now actually gates every PR instead of only running on a developer's
laptop, the regression baseline reflects a freshly measured floor with every delta
named and justified, and a future reader can learn the whole PTY accounting mechanism
— including the four things deliberately NOT done — from `docs/usage-cost.md` alone.**

## Performance
- **Started / Completed:** 2026-07-28
- **Tasks:** 2 of 2 completed
- **Files modified:** 4 (all modified, none new)

## Accomplishments
- `.woodpecker/qc.yaml`: added one `bun test supervisor/test/pty-usage-tail.test.ts`
  step (plus a single explanatory comment line) directly after `check-baseline`,
  since `check-baseline` walks `hub/test` only and would otherwise never run this
  phase's own supervisor-side test in CI. Verified no dollar-brace sequence was
  introduced anywhere in the file (`QC_YAML_OK`) and that the diff touches neither
  `services:` nor `environment:`.
- `tools/regression-baseline.json`: measured fresh from a bare checkout with no
  `REMO_E2E_DB_URL` / `DATABASE_URL` — actual rose from the recorded 2010/247/0/2257
  to 2059/255/0/2314. Wrote a new `_skip_note_ptycap` naming every file that added a
  pass or a skip, why each skip is DB-gated, and that 1 of the 8 new skips is
  pre-existing non-PTYCAP branch content rather than silently absorbed. Raised
  `skip_max` 248 -> 256 (+8, matching the full measured delta); left `pass_min` at
  1850 (~10.2% headroom, no reason to tighten); `fail_max` stays 0.
- `docs/usage-cost.md`: new "PTYCAP Phase 1" section — the end-to-end flow diagram
  parallel to the existing stream-json one, why the tail is supervisor-side (with a
  pointer to `no-hub-side-transcript-fs.test.ts`), the `runner_type` domain and its
  live CHECK constraint, the four recorded decisions (unsplit daily PK, unwired
  `transcript_path`, claude-only scoping, estimated-only cost), a RECORD-only note
  (gating is Phase 2), and the preserved Assumption-A2 operator smoke check.
- `CLAUDE.md`: extended the "Usage cost ledger" Docs map row by one sentence naming
  the new PTY source and the `runner_type` split; nothing else in the row or table
  changed.

## Task Commits
1. **Task 1: Wire the SC-1 proof into Woodpecker + re-measure the baseline** — `412ee0d` (ci)
2. **Task 2: Document the PTY accounting path and its four explicit deferrals** — `59f9362` (docs)

**Plan metadata:** tracking commit follows this SUMMARY.md.

## Files Created/Modified
- `.woodpecker/qc.yaml` — +1 comment line, +1 command entry.
- `tools/regression-baseline.json` — re-measured pass/skip/total, new `_skip_note_ptycap`, `skip_max` 248 -> 256.
- `docs/usage-cost.md` — +103 lines, new section appended, existing content untouched.
- `CLAUDE.md` — 1 line changed (Docs map row), rest of file untouched.

## Decisions Made
See `key-decisions` above — the skip-delta attribution (7 PTYCAP + 1 pre-existing
non-PTYCAP), the pass_min headroom call, and the corrected index name.

## Deviations from Plan
None beyond the index-name correction noted in `key-decisions` (the plan's own
`read_first` guessed `idx_token_usage_user_runner_type`; the actually-built name from
01-01 is `idx_token_usage_user_runner_created` — documented what was built, per this
task's own read-SUMMARY-first instruction).

## Issues Encountered
The measured skip delta (+8) did not cleanly match this phase's own new DB-gated
test count (+7) on first pass. Traced it to `hub/test/coolify-webhook-triage-e2e.test.ts`,
a file already present on this branch (unrelated scheduler/triage work, commits
`51e0def`..`5982b85`) before Phase 1's planning commit — its own single
`REMO_E2E_DB_URL`-gated skip accounts for the eighth. Confirmed by running every
new/modified test file individually rather than trusting the aggregate delta, per
this repo's "no unconditional skip, name every one" convention. Named explicitly in
`_skip_note_ptycap` rather than silently folded into PTYCAP's count.

## User Setup Required
None.

## Next Phase Readiness
This was the last plan in Phase 1. All four plans (01-01..01-04) are complete;
SC-1/SC-2/SC-3 are proven (locally and, for SC-1, now in CI too); the regression
baseline and docs are current. Phase 2 (the PTY pre-flight gate that actually
enforces the cost/token caps against `runner_type='pty-interactive'` spend) can
proceed once separately planned.

---
*Phase: PTYCAP-01-pty-token-accounting*
*Completed: 2026-07-28*
