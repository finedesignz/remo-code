---
phase: "3"
slug: "governed-automation-guard"
status: draft
nyquist_compliant: true
wave_0_complete: true
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
| 03-01-T1 | 01 | 1 | SC-1, SC-3 | T-03-01, T-03-03, T-03-06 | flag OFF == frozen legacy oracle over full (actor x runnerType) matrix; flag ON scheduler Telegram dispatch refused by kill_switch slot end-to-end | unit (differential) + pipeline e2e (mocked leaves) | `cd hub; bun test test/governed-pty-gate.test.ts` ; `cd hub; bun test test/telegram-human-only-guard.test.ts` ; `cd hub; bun test test/token-cap-coverage.test.ts` | created in task (TDD) | pending |
| 03-01-T2 | 01 | 1 | SC-1 | T-03-01 | ask/work compose governedAutomationPtyGate; external-ask denied with flag ON and all governors passing | static + unit | `cd hub; bun test test/ext-ask-gates.test.ts` ; `cd hub; bun test test/ext-work-containment.test.ts` | yes | pending |
| 03-01-T3 | 01 | 1 | SC-1, SC-3 | T-03-02, T-03-04 | governor order, enabled rule (governor_unconfigured), fail-closed slots, throw -> typed denial, non-PTY ok, DI-only, no alias | unit | `cd hub; bun test test/governed-pty-gate.test.ts` ; `cd hub; bun test test/human-only-guard.test.ts` ; `cd hub; bun test test/programmatic-hard-halt.test.ts` | yes (from T1) | pending |
| 03-02-T1 | 02 | 2 | SC-1, SC-3 | T-03-08, T-03-09, T-03-10 | preflight automation branch: flag first (before any DB gate), spend chain then governors, throw/hang fail closed | unit | `cd hub; bun test test/pty-preflight.test.ts` ; `cd hub; bun test test/token-cap-coverage.test.ts` ; `cd hub; bun test test/ws-client-pty-preflight.test.ts` | yes | pending |
| 03-02-T2 | 02 | 2 | SC-1, SC-3 | T-03-07, T-03-11 | human chain never runs a governor (flag ON + fail-closed production governors: human passes); CRLF-safe humanInteractive pin | unit + static-pin | `cd hub; bun test test/pty-preflight.test.ts` ; `cd hub; bun test test/human-interactive-flag-guard.test.ts` | yes | pending |
| 03-03-T1 | 03 | 3 | SC-2 | T-03-13 | Telegram source required; missing source fails closed; webhook passes 'human' | pipeline unit | `cd hub; bun test test/telegram-human-only-guard.test.ts` ; `cd hub; bun test test/telegram-dispatch.test.ts` | yes | pending |
| 03-03-T2 | 03 | 3 | SC-2 | T-03-12 | /ws/client strips client-asserted source/actor keys and preflights as human; agent spoof test unchanged | ws relay unit | `cd hub; bun test test/ws-client-pty-preflight.test.ts` ; `cd hub; bun test test/term-relay-human-guard.test.ts` | yes | pending |
| 03-03-T3 | 03 | 3 | SC-1, SC-2 | T-03-14..T-03-18 | door pins: 2 term.* emitters (self-checked), supervisor canary, caller pins, flag/DI literal pins, actor-inference pins, 2 exemptions | static-pin | `cd hub; bun test test/pty-door-guard.test.ts` ; `git diff --name-only $(git merge-base HEAD origin/main) -- supervisor/` | created in task | pending |
| 03-04-T1 | 04 | 4 | SC-1..SC-3 (docs) | T-03-21, T-03-22 | usage-cost.md Phase 3 section + MINOR-2 correction; CLAUDE.md flag + fail-closed fix; ROADMAP Phase-4 hand-off | doc test + grep | `cd hub; bun test test/docs-supersession.test.ts` ; `grep -c "PTYCAP Phase 3" docs/usage-cost.md` ; `grep -c "REMO_GOVERNED_AUTOMATION_PTY" CLAUDE.md` | yes | pending |
| 03-04-T2 | 04 | 4 | SC-1 (docs) | T-03-22 | drifted/old gate names gone from docs and SESSION-ASK spec | grep | `git grep -n governedAutomationGate -- docs .planning/architecture CLAUDE.md` ; `git grep -n humanOnlyPtyGate -- docs CLAUDE.md` | yes | pending |
| 03-04-T3 | 04 | 4 | SC-1 (contract) | T-03-24 | OpenAPI reasons cite governedAutomationPtyGate; rename total in hub/src; door pins still green | generator + grep + static-pin | `bun run docs:sync` ; `git grep -n -e humanOnlyPtyGate -e human_only_pty -- hub/src` ; `cd hub; bun test test/pty-door-guard.test.ts` | yes | pending |
| 03-04-T4 | 04 | 4 | SC-4 (+ all) | T-03-20, T-03-23 | full suite fail 0 / skip <= 260; five supervisor guards pass UNCHANGED; schema-lint OK; no docs drift | full suite + guards | `bun run check-baseline` ; `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts` ; `bun test supervisor/test/no-apikey-fallback-guard.test.ts` ; `bun test supervisor/test/default-backend-selector.test.ts` ; `bun test supervisor/test/pty-spawn-interception.test.ts` ; `bun test supervisor/test/no-legacy-agent-spawn.test.ts` ; `bun run schema-lint` | yes | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

All phase behaviors have automated verification. (Setting `REMO_GOVERNED_AUTOMATION_PTY` in prod is an owner-only cutover and is explicitly NOT part of this phase.)

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (12/12 tasks, each command followed by a `<fails_when>`)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none: new test files are created inside the task that introduces their subject)
- [x] No watch-mode flags
- [x] Feedback latency < 60s for per-file quick runs (the full `bun run check-baseline` runs only at wave/phase end, 03-04-T4)
- [x] `nyquist_compliant: true` set in frontmatter

Waves: one plan per wave (01 -> 02 -> 03 -> 04); all executors share one working tree and git index.

**Approval:** planner-complete (pending execution)
