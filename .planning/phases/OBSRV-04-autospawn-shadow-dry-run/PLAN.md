# OBSRV-04 Plan: Autospawn Shadow Dry-Run

## Goal
Add a flag-gated shadow dry-run mode (`REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW`) to the
build-session autospawn path. With the flag ON, `maybeAutospawnOffline` evaluates the
FULL AND-chain (allowlist, token cap, launch cap, supervisor check, grace dedup) but
records a "would-have-spawned" run-log entry and returns `{ kind: 'shadow_would_spawn' }`
WITHOUT calling `launchSessionForUser` or dispatching any prompt.

## Requirements

| ID | Requirement |
|----|-------------|
| SHADOW-01 | Flag-gated (`REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW`); default OFF; true no-op when off or allowlist empty |
| SHADOW-02 | Full AND-chain evaluated before shadow intercept; gate refusals still refuse |
| SHADOW-03 | `launchSessionForUser` NEVER called in shadow mode (non-negotiable safety invariant) |
| SHADOW-04 | Shadow record written to `routine_run_log` with `outcome: 'shadow_would_spawn'`, `command: 'autospawn-shadow'` |

## Implementation Plan

### 1. `hub/src/orchestrator/controller.ts`
Add `isAutospawnShadowEnabled()` following the exact same pattern as `isAutospawnEnabled()`:
reads `REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW`, accepts `1|true|yes|on`, default `'0'` (OFF).

### 2. `hub/src/orchestrator/inject.ts`
- Import `isAutospawnShadowEnabled` from `./controller.ts`
- Add `{ kind: 'shadow_would_spawn' }` to `InjectOutcome` union
- Add `isAutospawnShadowEnabled: typeof isAutospawnShadowEnabled` to `InjectDeps` interface
- Add `isAutospawnShadowEnabled` to `REAL_DEPS`
- Insert shadow intercept AFTER grace dedup (line 312), BEFORE `launchSessionForUser` (line 333):
  call `deps.appendRunLog` with `command: 'autospawn-shadow'`, `outcome: 'shadow_would_spawn'`;
  return `{ kind: 'shadow_would_spawn' }` — best-effort log, must not throw.

### 3. `hub/test/orchestrator-autospawn-shadow.test.ts`
Fast mocked unit test (no DB) — 8 tests covering SHADOW-01..04:
- No-op cases (no autospawn context, orchestrator gate OFF, autospawn gate OFF)
- Shadow flag OFF → real launch proceeds (positive case; asserts launchCalls=1)
- Shadow flag ON → zero launchCalls, result.kind='shadow_would_spawn' (SHADOW-03 hard constraint)
- Allowlist gate refuses before shadow intercept (SHADOW-02a)
- Token cap gate refuses before shadow intercept (SHADOW-02b)
- Run-log record has correct outcome + command (SHADOW-04)

## Key Constraints
- `command: 'autospawn-shadow'` ≠ `AUTOSPAWN_LAUNCH_COMMAND` (`'autospawn-launch'`) so shadow records
  are NOT counted by `countAutospawnLaunchesToday` toward the daily launch cap.
- No DB schema changes (existing `outcome` column holds `'shadow_would_spawn'`).
- No changes to real autospawn behavior, gates, or the no-auto-merge guard.
- `REMO_ORCHESTRATOR_AUTOSPAWN` stays OFF; allowlist stays empty.
- `tools/regression-baseline.json` NOT modified.
