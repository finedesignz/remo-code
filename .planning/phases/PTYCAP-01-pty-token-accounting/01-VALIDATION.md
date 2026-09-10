---
phase: 1
slug: pty-token-accounting
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-27
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun's built-in test runner (`bun:test`) — used uniformly across `hub/test/` and `supervisor/test/` |
| **Config file** | none — Bun test auto-discovers `*.test.ts`; CI gate is `bun run check-baseline` (`tools/regression-baseline.json`, per-file isolation) |
| **Quick run command** | `bun test <path/to/file>.test.ts` (per-file, matches the CI isolation model — avoids `mock.module` cross-file pollution) |
| **Full suite command** | `bun run check-baseline` |
| **Estimated runtime** | ~90-180 seconds (per-file isolated full baseline run) |

---

## Sampling Rate

- **After every task commit:** Run `bun test <the single new/changed test file>`
- **After every plan wave:** Run `bun run check-baseline`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01 | TBD | TBD | SC-1 (mid-turn observable) | T-1-01 | A `usage_event` with `runner_type:'pty-interactive'` lands in `token_usage` while a simulated PTY transcript is still being appended to (before an exit/kill frame) | integration | `bun test supervisor/test/pty-usage-tail.test.ts` | ❌ W0 | ⬜ pending |
| 01-02 | TBD | TBD | SC-2 (separate buckets) | T-1-02 | Two `recordTokenUsage()` calls with different `runnerType` produce two `token_usage` rows distinguishable by `runner_type`; a third/invalid value is rejected | unit | `bun test hub/test/token-usage-runner-type.test.ts` | ❌ W0 | ⬜ pending |
| 01-03 | TBD | TBD | SC-3 (mid-flight detectable) | T-1-03 | After N simulated incremental transcript writes, `getTodayTokenTotal()` reflects the cumulative sum without waiting for session-close | integration | `bun test hub/test/pty-usage-midflight-visibility.test.ts` | ❌ W0 | ⬜ pending |
| 01-04 | TBD | TBD | regression: usage_event backward-compat | — | An old-shape `usage_event` (no `runner_type` field) still records with `runner_type='stream-json'` default | unit | `bun test hub/test/usage-event-handler.test.ts` (extend existing) | ✅ existing, extend | ⬜ pending |
| 01-05 | TBD | TBD | regression: transcript-file host boundary (Pitfall 1) | T-1-04 | No new `hub/src/**` module reads `homedir()`-derived transcript paths directly — the hub container has no `~/.claude/projects` | static/guard | `bun test hub/test/no-hub-side-transcript-fs.test.ts` | ❌ W0 (optional but recommended) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*Task IDs, Plan, and Wave columns are placeholders (TBD) — the planner assigns final task/plan/wave numbers in PLAN.md; this table's Requirement -> Test Command mapping is authoritative and must be preserved across that assignment.*

---

## Wave 0 Requirements

- [ ] `supervisor/test/pty-usage-tail.test.ts` — covers SC-1; needs a fixture that writes a fake growing JSONL file (reuse `hub/test/transcript-adapter-claude.test.ts`'s fixture pattern if applicable to the supervisor side)
- [ ] `hub/test/token-usage-runner-type.test.ts` — covers SC-2
- [ ] `hub/test/pty-usage-midflight-visibility.test.ts` — covers SC-3
- [ ] `hub/test/no-hub-side-transcript-fs.test.ts` — optional guard canary for Pitfall 1 (same style as `no-legacy-agent-spawn.test.ts`)
- [ ] Framework install: none — `bun:test` already present

---

## Manual-Only Verifications

*None — all phase behaviors (SC-1, SC-2, SC-3, and the two regression/guard behaviors) have automated verification per the table above.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 180s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
