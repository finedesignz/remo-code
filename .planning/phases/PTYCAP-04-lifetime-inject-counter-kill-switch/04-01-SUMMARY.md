---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
plan: 01
subsystem: supervisor-usage
tags: [pty-usage, token-accounting, dedupe, bun-test, version-bump]

requires:
  - phase: PTYCAP-01-pty-token-accounting
    provides: PtyUsageEmitter, runner_type 'pty-interactive' usage_event frames (gap G-1 found in 01-VERIFICATION)
provides:
  - PTY usage emitter counts once per assistant message (message.id dedupe, per-bucket maxima, positive deltas)
  - supervisor 0.15.1 (single-source files)
affects: [PTYCAP-04-02..08 (hub cap drop to 20M depends on corrected PTY accounting), supervisor release]

plan_head_before: 126e6cb6eedbd854e93cc9e304505c7e8a91a81a
actuals:
  tokens: 9000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Cumulative-usage records collapse via an insertion-ordered key->maxima Map with FIFO eviction"

key-files:
  created: []
  modified:
    - supervisor/src/usage/pty-usage-emitter.ts
    - supervisor/test/pty-usage-tail.test.ts
    - supervisor/tauri/src-tauri/tauri.conf.json
    - supervisor/tauri/src-tauri/Cargo.toml
    - supervisor/tauri/src-tauri/Cargo.lock
    - supervisor/tauri/ui/package.json

key-decisions:
  - "Dedupe key = trimmed non-empty message.id, fallback record uuid; a record with neither emits its full usage as before"
  - "Eviction applies only when inserting a NEW key (updating an existing key does not reorder or evict)"

requirements-completed: [G-1]

coverage:
  - id: D1
    description: "Three same-message.id cumulative records emit frames summing to the last record, never negative, replay-safe, bounded"
    requirement: "G-1"
    verification:
      - kind: unit
        ref: "supervisor/test/pty-usage-tail.test.ts#PtyUsageEmitter - message.id dedupe with cumulative usage (G-1, D-15)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Supervisor version 0.15.1 in all four single-source files"
    verification:
      - kind: unit
        ref: "supervisor/test/version-drift.test.ts"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-10-13
status: complete
---

# Phase PTYCAP-04 Plan 01: G-1 PTY usage dedupe + 0.15.1 Summary

**PTY usage emitter now dedupes on message.id (fallback uuid) with per-bucket maxima and positive-delta emission, so cumulative multi-record assistant messages count once instead of ~2.5x; supervisor bumped to 0.15.1.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2 of 2
- **Files modified:** 6

## Accomplishments

- `pty-usage-emitter.ts`: `seen` is now an insertion-ordered `Map<key, {input, output, cacheCreation, cacheRead}>`. onRecord keeps the zero-bucket skip first, computes per-bucket deltas against stored maxima, clamps negatives to 0, keeps `max(old, new)`, and returns without emitting when all four deltas are 0. Frame shape and `runner_type: 'pty-interactive'` unchanged. FIFO eviction at `SEEN_UUID_CAP` (5000) retained.
- Six new fixtures (new describe block, 151 added lines, no existing test edited): three-records-one-id (sum equals last record), out-of-order smaller bucket (no frame, max kept, later 95 emits delta 5), byte-identical replay emits nothing, no-message.id uuid fallback, all-zero record skipped before bookkeeping, FIFO bound (evicted oldest id emits again).
- Version 0.15.0 -> 0.15.1 in tauri.conf.json, Cargo.toml, Cargo.lock (supervisor package entry, one line), ui/package.json. `supervisor/package.json` and `version.ts` untouched.

## Task Commits

1. Task 1: `0de6635` fix(PTYCAP-04-01): dedupe PTY usage on message.id with per-bucket maxima and positive deltas
2. Task 2: `eb4fa91` chore(PTYCAP-04-01): bump supervisor to 0.15.1

## Verification

| Gate | Before | After |
|------|--------|-------|
| `supervisor/test/pty-usage-tail.test.ts` | 28 pass / 0 fail | 34 pass / 0 fail (RED run: 31 pass / 3 fail before the emitter change) |
| `supervisor/test/pty-usage-path-containment.test.ts` | 6 pass / 0 fail | 6 pass / 0 fail |
| `supervisor/test/version-drift.test.ts` | 3 pass / 0 fail | 3 pass / 0 fail |
| `bun run check-baseline` | baseline pass=2379 skip=259 fail=0 | pass=2379 skip=259 fail=0 (second run; see deviations) |
| tsc on `pty-usage-emitter.ts` (ad hoc strict, bun-types; supervisor has no tsconfig) | n/a | 0 errors |

Note: check-baseline total did not change (2638) because the baseline does not count supervisor tests; the six new tests run via the per-file CI gate (`.woodpecker/qc.yaml` runs pty-usage-tail.test.ts).

## Deviations from Plan

**1. [Flake, not a code deviation] First check-baseline run had fail=1**
- `hub/test/transcript-adapter-codex.test.ts > persisted id present but no matching file` took 43.8s and failed in the full run; run alone it passes (8/8, 1.9s) and the second full check-baseline run is fully green (fail=0, skip=259). Unrelated to this plan (hub Codex adapter; no touched file). Not ticketed: not reproducible, no stable error signature.

Otherwise: plan executed as written. Task 1 was committed once (RED then GREEN verified locally before the single commit), consistent with the plan's "Task 1 commit shows only added lines" criterion.

## Known Stubs

None.

## Threat Flags

None. T-04-01 (maxima never decrease, negatives clamp) and T-04-02 (FIFO bound) mitigations asserted by fixtures. T-04-03 accepted: hosts need a signed MSI (push a `supervisor-v*` tag -> release-supervisor.yml) before the corrected emitter takes effect; hub deploys on merge, so until hosts update the effective PTY ceiling stays roughly 2.5x lower than real consumption. Disclose in the PR body (04-08).

## Self-Check: PASSED

- 0de6635 and eb4fa91 present on branch phase-ptycap-04-lifetime-counter-kill-switch
- `git diff --name-only $PLAN_BASE..HEAD -- supervisor/package.json supervisor/src/version.ts` empty; `-- supervisor/test` lists only pty-usage-tail.test.ts
