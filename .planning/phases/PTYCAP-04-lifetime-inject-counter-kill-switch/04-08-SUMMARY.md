---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
plan: 08
subsystem: docs-and-cap
tags: [docs, openapi, token-cap, baseline, phase-gate]

requires:
  - phase: PTYCAP-04-01..07
    provides: ledger, kill switch, governors, routes, alarm, heal machine surface
provides:
  - POST /api/sessions/heal registered in the hand-assembled OpenAPI with its two automation 503 bodies
  - CLAUDE.md, docs/usage-cost.md ("PTYCAP Phase 4") and ROADMAP describe what the code does
  - default daily token cap 20_000_000 as the LAST code commit, baseline re-measured
affects: [PTYCAP-05, PTYCAP-06, Milestone GOV]

plan_head_before: c7b172356483cc9a3436088278f54b31157bdfbc
cap_sha: 386f0312317c5170b1b67238a08cc5e549fa3ea2
actuals:
  tokens: 60000
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Spec-only OpenAPI block for a plain-Hono route (same shape as the automation block)"

key-files:
  created: []
  modified:
    - hub/src/api/_openapi.ts
    - docs/openapi.json
    - docs/api.md
    - CLAUDE.md
    - docs/usage-cost.md
    - .planning/ROADMAP.md
    - hub/src/dispatch/gates.ts
    - hub/src/observability/orchestrator-metrics.ts
    - hub/test/token-cap-gate-fires.test.ts
    - hub/test/orchestrator-token-cap.test.ts
    - hub/test/orchestrator-inject-rate-gate.test.ts
    - hub/test/e2e/orchestrator-tokencap.e2e.test.ts
    - docs/auto-dev-orchestrator.md
    - docs/orchestrator-autospawn-runbook.md
    - tools/regression-baseline.json

key-decisions:
  - "The heal route was absent from the OpenAPI entirely, so the two new 503 bodies were added by registering the whole route (202/400/401/500/503 union) rather than a partial entry"
  - "Historic incident wording (28x over a 50M ceiling) kept where it describes the 2026-07 event; only live-default statements changed; the 28x test title and e2e comment that compare the incident to the CURRENT cap now say 70x"

requirements-completed: [SC-1, SC-2, SC-3, SC-4]

duration: ~60min
completed: 2026-10-13
status: complete
---

# Phase PTYCAP-04 Plan 08: Docs sweep + 20M default cap Summary

**Phase 4 documented (env vars, routes, emergency paths, literal 1000 lifetime cap with 80 percent warning, residuals), heal 503 bodies added to OpenAPI, and the default daily token cap lowered from 50M to 20M as the last code commit.**

## Commits

| Commit | Content |
|---|---|
| `1f0f0d4` | docs: register POST /api/sessions/heal (+ `automation_halted`, `lifetime_inject_exhausted` 503 bodies); regenerated `docs/openapi.json` and `docs/api.md` |
| `4d724a7` | docs: CLAUDE.md (env vars, invariants, literal-cap and emergency-path paragraphs, docs-map row), `docs/usage-cost.md` (PTYCAP Phase 4 section, real Governors table), ROADMAP hand-off delivered + GOV follow-ups |
| `386f031` (CAP_SHA) | feat: default daily token cap 20M, test/doc literals, baseline re-measure. LAST code commit; only this summary commit follows |

## Verification

| Gate | Result |
|---|---|
| `docs-supersession.test.ts` | 4 pass |
| `token-cap-gate-fires` / `orchestrator-token-cap` / `orchestrator-inject-rate-gate` | 8 / 9 / 8 pass |
| `token-cap-coverage`, `orchestrator-metrics`, `orchestrator-cap-alert` (large-number fixtures, untouched) | 20 pass together |
| `orchestrator-tokencap.e2e.test.ts` | 5 skipped locally (DB-gated, unchanged); `test(` count 3 before and after |
| `bun run check-baseline` (final, after the baseline write) | pass=2652 skip=259 fail=0 total=2911, OK within tolerance (baseline was 2379/259/0/2638) |
| `bun run schema-lint` | OK |
| `tsc --noEmit` (hub) | 427 errors (equal to baseline), also after the OpenAPI block |
| `bun run docs:sync` | run twice after the OpenAPI edit (identical, additions only) and again after the cap commit: no drift |
| supervisor `pty-usage-tail` / `pty-usage-path-containment` / `version-drift` | 34 / 6 / 3 pass |
| supervisor SC-4 guards: no-api-key-no-streamjson-pty / no-apikey-fallback-guard / default-backend-selector / pty-spawn-interception / no-legacy-agent-spawn | 5 / 7 / 22 / 3 / 1 pass, no supervisor test file changed in this plan |

## Deviations from Plan

**1. [Info] check-baseline run 1 of the cap task had fail=1**
The first full run reported `pass=2651 skip=259 fail=1`; the failing test name was not captured (output was tailed). The immediate rerun, and a third run after the baseline file write, were both fail=0 (`pass=2652`). Same unreproduced intermittent as 04-01, 04-04 and 04-07 (the known `transcript-adapter-codex` timing flake is the prime suspect but is NOT confirmed). No touched file is implicated. Not ticketed (no stable error signature).

**2. [Rule 3 - Scope addition] Heal route registered in full in the OpenAPI**
Requested: add the two 503 bodies. The route had no OpenAPI entry at all, so a spec-only block for `POST /api/sessions/heal` was added (202, 400, 401, 500, 503 union including the pre-existing `quota_threshold_reached` / `no_target_available`). tsc stays 427.

**3. [Info] Task 1 docs name the 20M default in the ROADMAP delivery note and in CLAUDE.md**
The plan asked Task 1 not to spell the default; the ROADMAP "Delivery notes" line says "20M default", written before the cap commit. Harmless to the commit-order lock (docs only); the value is the shipped one.

**4. [Info] CLAUDE.md stale sentence**
The "stale fail-open sentence" the plan names was the Phase-3 `REMO_GOVERNED_AUTOMATION_PTY` line (`governor_not_implemented ... until Phase 4`), fixed in Task 1; the token-cap fail-closed wording in CLAUDE.md was already correct. The stale fail-open comment in `gates.ts` (the DEFAULT_DAILY_TOKEN_CAP doc comment) was rewritten as fail-closed. Other `fail-open` comments in `gates.ts` belong to the cost cap, inject-rate and launch-cap gates and are accurate, untouched.

**5. [Info] Line endings**
`CLAUDE.md`, `docs/usage-cost.md` and the other docs are CRLF in the working tree; edits preserved CRLF (one transient LF row was normalised before commit).

## Surviving 50M / 50_000_000 / 50000000 hits (reasons)

- `hub/test/orchestrator-cap-alert.test.ts`, `orchestrator-metrics.test.ts` (+ the `daily_token_cap 50000000` metric expectation), `orchestrator-autospawn-inject.test.ts`, `orchestrator-inject-counterkey.test.ts`: the number is an INJECTED `getTokenCapStatus` / `tokenStatus` parameter, not the shipped default. Untouched on purpose.
- `hub/test/token-cap-gate-fires.test.ts:5` and `hub/test/e2e/orchestrator-tokencap.e2e.test.ts:6`: historic description of the 2026-07 incident against the ceiling that was then in force.
- `hub/src/dispatch/gates.ts:156` and `CLAUDE.md` PTYCAP paragraph: "lowered from / was 50M" change notes.
- `web/test/term-refusal.test.ts`: reason-string fixture for a UI formatter, not a default. Untouched.
- `.planning/` codebase maps and the 07/09 SPEC files: informational / future specs, left as the plan directs.

## PR-body checklist (for the draft PR #506)

- LITERAL lifetime cap: default 1000 per counter key, env-raisable (`REMO_AUTOMATION_LIFETIME_INJECT_CAP`), owner reset only; a 15 minute cron exhausts it in about ten days; one-shot warning page at 80 percent and an exhaustion page per key and reset epoch; recurring automation continues only through owner resets or a raised cap (panel F-5a).
- DEFAULT DAILY TOKEN CAP now 20M (was 50M). Applies ONLY where `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` is unset. HUMAN PTY usage counts and the human preflight checks it on every Enter, so a lowered cap can lock the owner out of their own terminal. OWNER ACTION: check the prod env value before deploy. This run changed NO prod env value and flipped NO flag.
- G-1 ordering window: the corrected PTY usage emitter (supervisor 0.15.1) needs a SIGNED supervisor MSI (`supervisor-v*` tag); the hub deploys on merge, so until hosts update PTY consumption is recorded about 2.5x too low while the cap is already 20M.
- `.woodpecker/qc.yaml` runs only two supervisor test files (`pty-usage-tail`, `pty-usage-path-containment`); the other supervisor guards ran locally only.
- Real-Postgres proof: `hub/test/e2e/automation-controls-checks.ts` (called from an existing DB-gated e2e body, zero new skips) runs only in the Woodpecker run on the draft PR; read the result once at phase end, no polling. It was never run locally (no Postgres on this host).
- Residual: with `REMO_GOVERNED_AUTOMATION_PTY` ON the ask, work and telegram governed lists carry no counter key, so the `lifetime_counter` governor refuses `lifetime_counter_key_missing` until Phase 5/7 (fail closed, flag default OFF).
- Other documented residuals: engage does not cancel in-flight turns; delete and recreate re-mints a counter key; a halt after a once-task claim re-arms the task; release of any scope resumes deferred work in that scope.
- Deferred to Milestone GOV: Telegram or UI kill-switch trigger; opt-in `stop_running` cancellation; QC-key counter policy (Phases 7/8); cap-hit QC kind (Phase 9).
- Owner emergency paths: API engage (cookie or JWT, no step-up, needs an ACTIVE license), env break-glass plus restart (works with the DB down, not immediate), release and reset need a login under 15 minutes old.

## Known Stubs

None.

## Threat Flags

None. T-04-38 (owner lockout at the lowered cap) accepted and documented prominently; T-04-39 mitigated by commit order plus the PR-body disclosure; T-04-40 mitigated (zero test() added, skip 259, skip_max 260); T-04-41 (docs name variables and behavior only) and T-04-42 (80 percent plus exhaustion pages, documented) mitigated.

## Self-Check: PASSED

- 1f0f0d4, 4d724a7 and 386f031 present on `phase-ptycap-04-lifetime-counter-kill-switch`; `git diff --name-only 386f031..HEAD -- hub/src supervisor/src` is empty.
- `git grep governor_not_implemented -- docs CLAUDE.md` prints nothing; `PTYCAP Phase 4` in `docs/usage-cost.md`, `automation_halted`, `lifetime_counter_key_missing` and the 80 percent text present as required.
