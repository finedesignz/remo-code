---
phase: "3"
slug: "governed-automation-guard"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-07"
---

# Phase 3 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test 1.3.14 (hub unit tests are DB-free; leaf-module mocks) |
| **Config file** | `hub/bunfig.toml` (preload `./test/_setup.ts`) |
| **Quick run command** | `cd hub; bun test test/<touched>.test.ts` (one file per process) |
| **Full suite command** | `bun run check-baseline` (per-file isolation, fail_max 0, skip_max 260) |
| **Estimated runtime** | quick ~2-10 s per file; full suite measured at baseline (see check-baseline log) |

---

## Sampling Rate

- **After every task commit:** Run the quick command for each test file the task touched
- **After every plan wave:** Run `bun run check-baseline` plus the supervisor guard files (SC-4)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds for quick runs

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (filled by the planner per task) | | | SC-1..SC-4 | | | unit / static-pin | `cd hub; bun test test/<file>` | W0 not needed | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

All phase behaviors have automated verification. (Setting `REMO_GOVERNED_AUTOMATION_PTY` in prod is an owner-only cutover and is explicitly NOT part of this phase.)

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
