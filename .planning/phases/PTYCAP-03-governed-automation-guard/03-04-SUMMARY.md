---
phase: PTYCAP-03-governed-automation-guard
plan: 04
subsystem: docs
tags: [pty, governed-automation, docs, openapi, regression-baseline, supervisor-guards]
status: complete

requires:
  - phase: PTYCAP-03-governed-automation-guard
    provides: 03-01 governed-pty module, 03-02 preflight automation branch, 03-03 door pins and Telegram source
provides:
  - docs/usage-cost.md "PTYCAP Phase 3" section plus Phase-2 mechanism corrections (structural user_message routing, Telegram plain text via user_message)
  - CLAUDE.md REMO_GOVERNED_AUTOMATION_PTY env bullet, docs-map row, cross-cutting invariant, token-cap fail-open sentence fixed
  - ROADMAP Phase 4 hand-off note (no SC text or checkbox change)
  - humanOnlyPtyGate -> governedAutomationPtyGate rename finished across docs, SESSION-ASK spec and hub/src comments
  - Regenerated OpenAPI artifacts and re-measured regression baseline with phase-3 accounting
affects: [PTYCAP-04, PTYCAP-05]

actuals:
  tokens: 4500
  tasks: 4
  commits: 4
plan_head_before: a7c2e3a

tech-stack:
  added: []
  patterns:
    - "Honest-scope documentation: name which gates are NOT the door and what is proven only under test DI"

key-files:
  created: []
  modified:
    - docs/usage-cost.md
    - CLAUDE.md
    - .planning/ROADMAP.md
    - docs/session-ask.md
    - docs/remo-work.md
    - docs/scheduled-tasks.md
    - docs/telegram-bridge.md
    - .planning/architecture/SESSION-ASK-API-SPEC.md
    - hub/src/api/_openapi.ts
    - hub/src/api/ext.ts
    - hub/src/auth/ext-api-key-middleware.ts
    - hub/src/ws/client.ts
    - docs/openapi.json
    - docs/api.md
    - tools/regression-baseline.json

key-decisions:
  - "No governed reason can reach the web terminal, so web/src/lib/termRefusal.ts needs no mapping (left unedited)"
  - "Baseline informational counts re-measured to pass=2378 skip=259 total=2637; tolerance block untouched"

requirements-completed: [SC-4, SC-1, SC-2, SC-3]
completed: 2026-10-13
---

# Phase PTYCAP-03 Plan 04: Docs close-out and full phase gate Summary

The governed-automation guard is documented where PTYCAP lives (with the honest-scope statement and Phase-4 hand-off), the rename is total in docs and hub/src, and the full gate is green: check-baseline fail 0 / skip 259, all five SC-4 supervisor guards pass with no supervisor/ diff.

## Tasks and commits

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | usage-cost Phase 3 section, Phase-2 corrections, CLAUDE.md, ROADMAP hand-off | 5676b12 `docs(PTYCAP-03-04): document governed-automation guard, correct Phase-2 mechanism claims, Phase-4 hand-off` | docs/usage-cost.md, CLAUDE.md, .planning/ROADMAP.md |
| 2 | Finish rename across remaining docs and SESSION-ASK spec | da575ed `docs(PTYCAP-03-04): finish humanOnlyPtyGate -> governedAutomationPtyGate rename ...` | docs/session-ask.md, docs/remo-work.md, docs/scheduled-tasks.md, docs/telegram-bridge.md, .planning/architecture/SESSION-ASK-API-SPEC.md |
| 3 | OpenAPI reason descriptions, source comments, docs:sync | a7aa1d7 `docs(PTYCAP-03-04): OpenAPI reason descriptions cite governedAutomationPtyGate; finish rename in hub/src comments` | hub/src/api/_openapi.ts, hub/src/api/ext.ts, hub/src/auth/ext-api-key-middleware.ts, hub/src/ws/client.ts, docs/openapi.json, docs/api.md |
| 4 | Re-measured regression baseline | bf56f4f `chore(PTYCAP-03-04): re-measure regression baseline (pass 2378 skip 259 fail 0) with phase-3 accounting` | tools/regression-baseline.json |

## Phase gate results

| Gate | Result |
| ---- | ------ |
| `bun run check-baseline` | exit 0, "OK within tolerance": pass=2378 skip=259 fail=0 total=2637 (untouched-tree start pass=2304 skip=259 fail=1; net +74 pass, 0 new skips; the 1 CRLF failure is now a pass) |
| Supervisor guards (each own process) | no-api-key-no-streamjson-pty 5 pass; no-apikey-fallback-guard 7 pass; default-backend-selector 22 pass; pty-spawn-interception 3 pass; no-legacy-agent-spawn 1 pass; 0 fail anywhere |
| `git diff --name-only $(merge-base HEAD origin/main) -- supervisor/` | prints nothing (SC-4: guards pass unchanged) |
| `bun run schema-lint` | OK, no un-pragma'd mutating statements (5 allowed) |
| `bun run docs:sync` then `git status --porcelain -- docs/openapi.json docs/api.md` | prints nothing (no drift) |
| `git grep -e humanOnlyPtyGate -e human_only_pty -- hub/src` | prints nothing |
| `git grep governedAutomationGate -- docs .planning/architecture CLAUDE.md` | prints nothing |
| `git grep humanOnlyPtyGate -- docs CLAUDE.md` minus lines with formerly/renamed | 0 lines |
| `hub/test/docs-supersession.test.ts` | 4 pass |
| `hub/test/pty-door-guard.test.ts` after comment edits | 21 pass |
| `git diff -U0 .planning/ROADMAP.md` | added lines only (the Phase-4 hand-off paragraph) |
| tsc (`cd hub; bunx tsc --noEmit -p tsconfig.json`) | 427 errors before and after; sorted error lines identical (no new error by file:line). The only governed-pty/preflight/telegram-matching lines are pre-existing errors in test/telegram-webhook.test.ts; none in hub/src/dispatch/governed-pty.ts, dispatch/pty-preflight.ts, telegram/dispatch.ts or api/telegram-webhook.ts. |

## termRefusal check (Task 3 step 4)

`web/src/lib/termRefusal.ts` maps only over_daily_cost_cap, over_daily_token_cap, quota_threshold_reached, pty_preflight_timeout/error, term_backpressure and not_current_writer, and falls back to `Prompt not sent (<reason>)`. The term-channel `send_refused` only carries human-chain reasons and plan 03-02 pins that the human chain never runs a governor, so no `automation_blocked_on_pty:*` governed reason can reach the web terminal. No mapping needed; file unedited.

## Deviations from Plan

None - plan executed as written, with these notes (not deviations):
- CLAUDE.md edits were applied with a byte-preserving script for three single-token replacements (file is CRLF in the working tree); line endings verified consistent. The Session-Ask row rename also covered the Inbound-email (`remo_work`) row's "human-only-PTY" wording so no stale present-tense gate name remains.
- docs/telegram-bridge.md: one additional line ("human-only-PTY" in the pipeline ordering sentence) was updated to "governed-automation PTY guard", and the required-source sentence was added next to the guard paragraph.
- The ledger file `gsd-plan-head-before-PTYCAP-03-04` was not created before the first commit; `plan_head_before` is the spawn-time HEAD a7c2e3a and `commits: 4` is `git rev-list --count a7c2e3a..HEAD` measured at SUMMARY write (before the SUMMARY's own commit).
- `_skip_note_ptycap_phase3` itemises 68 of the +74 new passes (28 governed-pty-gate, 21 pty-door-guard, 13 pty-preflight, 2 ws-client-pty-preflight, 2 net telegram-human-only-guard, 1 ext-ask-gates, 1 CRLF fix); the other 6 are loop-generated cases a source-line diff undercounts, and the note says so rather than inventing attribution.

## Known Stubs

None.

## Threat Flags

None - docs, comment-only source edits and regenerated artifacts; no new endpoints, auth paths or schema changes. T-03-20 mitigated (five supervisor guards pass, no supervisor/ diff), T-03-21/22 mitigated (default OFF, owner-only cutover and honest scope documented; no production value for REMO_GOVERNED_AUTOMATION_PTY documented), T-03-23 mitigated (fail 0, skip 259 <= 260, tolerance unchanged), T-03-24 mitigated (no docs drift).

## Self-Check: PASSED

- 03-04 modified files: FOUND (git status clean after commit bf56f4f)
- Commits 5676b12, da575ed, a7aa1d7, bf56f4f: FOUND on branch phase-ptycap-03-governed-automation-guard
- STATE.md intentionally not touched; ROADMAP only received the Phase-4 hand-off note (orchestrator owns checkboxes)
