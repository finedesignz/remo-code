# Phase 12 QC Build Report

Worktree: `C:/Users/artic/GitHub/remo-code-ui-restructure`
Date: 2026-05-28

## Summary

| Step | Cmd | Exit | Result |
|------|-----|------|--------|
| 1 | `bun install` | 0 | OK — 269 installs / 345 packages, no changes |
| 2 | `web/ bunx tsc --noEmit` | 0 | PASS — 0 TS errors |
| 3 | `web/ bun run build` | 0 | PASS — clean build (1 size warning) |
| 4 | `hub/ bunx tsc --noEmit` | N/A | NOT APPLICABLE — no `hub/tsconfig.json` (and no root tsconfig); tsc printed its help screen. Hub is Bun runtime-checked, no tsc config in repo |
| 5 | `hub/ bun test` | 1 | 495 pass / 7 fail / 93 skip / 1335 expects / 595 tests / 64 files / 1130ms |
| 6 | `supervisor/ bun test` | 0 | 50 pass / 0 fail / 129 expects / 50 tests / 7 files / 26.52s |

## Step 2 — web tsc

0 errors. EXIT=0.

## Step 3 — web build

```
vite v6.4.1 building for production...
✓ 388 modules transformed.
dist/index.html                   0.61 kB │ gzip:   0.36 kB
dist/assets/index-DnzBIQuE.css   64.68 kB │ gzip:  11.21 kB
dist/assets/index-D1Osdixg.js   689.68 kB │ gzip: 201.21 kB
(!) Some chunks are larger than 500 kB after minification.
✓ built in 2.37s
```

Warnings: single chunk-size advisory (689.68 kB JS > 500 kB threshold). Not a failure. No type errors (`tsc -b` ran clean before vite).

## Step 4 — hub tsc

**Not applicable.** No `hub/tsconfig.json` exists; no root `tsconfig.json` exists. `bunx tsc --noEmit` with no project file falls through to its help screen. Hub has no `typecheck` npm script. Hub typing is enforced at Bun runtime + via `bun test`. No drift introduced by this phase.

## Step 5 — hub test

**495 pass / 7 fail / 93 skip / 1335 expect() / 595 tests across 64 files. EXIT=1.**

Matches Wave 4 baseline exactly (`495 pass / 7 fail / 93 skip`). No regressions from Phase 12 changes. The 7 failures are pre-existing on `main`; 93 skips are e2e cases gated on `REMO_E2E_DB_URL`.

### Failing tests (all pre-existing, NOT introduced by Phase 12):

1. `insertRunV2 started_at safety > passes a non-null Date for started_at when status=pending and started_at omitted`
2. `insertRunV2 started_at safety > passes a non-null Date for status=success path`
3. `insertRunV2 started_at safety > honors caller-provided started_at when given`
4. `insertRunV2 started_at safety > defends against an explicit null started_at (cron-fire registry path)`
5. `insertDeploymentRun started_at safety > passes now() (not null) for status=pending`
6. `supervisor-registry reconnect race > new register replaces old entry; isSupervisorOnline true`
7. `supervisor-registry reconnect race > stale close from replaced socket does NOT wipe live entry`

## Step 6 — supervisor test

**50 pass / 0 fail / 129 expects / 50 tests / 7 files / 26.52s. EXIT=0.** Matches prior-wave baseline.

## New failures vs. main baseline

None. Hub 7-fail set is identical to Wave 4 baseline. Supervisor 50/50 unchanged.

## Verdict

PASS (no regressions). Hub TS-check (Step 4) is N/A by repo design. Hub test exits non-zero due to 7 pre-existing failures carried from main.
