# Milestone Summaries Index - remo-code

Generated 2026-10-13 from `.planning/` artifacts (PROJECT.md, ROADMAP.md, STATE.md, milestones/, phases/PTYCAP-*) and merged-PR history. STATE.md was intentionally not touched. "Thin" = summarized mostly from PROJECT.md / CLAUDE.md / PR titles.

| Milestone | Status | Dates | Key PRs | One-line outcome |
|-----------|--------|-------|---------|------------------|
| [V1](MILESTONE_SUMMARY-V1.md) (v1.0, 14 phases) | shipped | 2026-05-10 to 2026-06-02 (archived) | #3, #205-#211, #242 | Hub + supervisor + web chat, scheduler, grid, Codex, Titanium auth, settings overhaul (partial artifacts) |
| [PTY](MILESTONE_SUMMARY-PTY.md) (m-interactive-pty-runner, P15-20) | shipped | 2026-06-01 to 2026-06-05 (PROJECT.md: 06-04) | #235, #244-#246, #283 | Interactive ConPTY TUI is the default human surface, no API key (thin) |
| [AUTODEV](MILESTONE_SUMMARY-AUTODEV.md) (P21-32) | shipped, flag OFF | 2026-06-07 | #266, #267 | Session-level auto-dev orchestrator with queue and verify-tail (thin) |
| [TMAC](MILESTONE_SUMMARY-TMAC.md) | shipped | 2026-06-08 to 2026-06-09 | #270, #271, #273-#275 | One macro prompt per task type, sentinel-driven resume heartbeat (thin) |
| [OEE](MILESTONE_SUMMARY-OEE.md) | shipped | 2026-06-26 | #300-#302 | Orchestrator proven e2e against real Postgres in CI |
| [BSA](MILESTONE_SUMMARY-BSA.md) | shipped (OFF by default) | 2026-06-26 | #303 | Gated build-session autospawn, allowlist, token cap |
| [OBSRV](MILESTONE_SUMMARY-OBSRV.md) | cancelled (evidence conflict) | scoped 2026-06-27, cancelled 2026-07-12 | #309, #311, #314, #316 (merged), #312 | Run-log API + Activity panel landed; shadow mode never shipped |
| [TEAB](MILESTONE_SUMMARY-TEAB.md) | shipped | 2026-06-29 to 2026-07-06 | #323, #324 | `teab run` as a scheduled task via supervisor commands (thin) |
| [BLEED](MILESTONE_SUMMARY-BLEED.md) | shipped | 2026-07-09 to 2026-07-12; reconciled 2026-09-28 | #328, #330, #342-#344, #346, #492 | Run leak, circuit breaker, token cap on all 7 paths proven (thin) |
| [ASK](MILESTONE_SUMMARY-ASK.md) | shipped | 2026-07-14 to 2026-07-21 | #366, #369, #373, #385 | External `/api/ext` session read + paid ask surface (thin) |
| [WORK](MILESTONE_SUMMARY-WORK.md) | shipped | 2026-07-14 | #368, #373 | Inbound email to repo agent to hub-gated publish (thin) |
| [ONCE](MILESTONE_SUMMARY-ONCE.md) | shipped | 2026-07-14 | #371 | One-time scheduled tasks (thin) |
| [PTYCAP](MILESTONE_SUMMARY-PTYCAP.md) | in-progress | 2026-07-14 (dirs) to present | #395, #493 merged; #505, #506 open; #353 spec | Token-gate the PTY: P1-P2 shipped, P3 PR open, P4 PR open, P5-P9 not built |
| [MSESS](MILESTONE_SUMMARY-MSESS.md) | planned (scoped) | scoped 2026-07-13 | none | N sessions per repo; gated on PTYCAP |
| [GOV](MILESTONE_SUMMARY-GOV.md) | planned | - | none | Org spend ledger, policy caps, audit, kill switch, receipts page (thin) |
| [TENANT](MILESTONE_SUMMARY-TENANT.md) | planned | - | none | Retire TITANIUM_BYPASS, real multi-tenancy (thin) |
| [MONEY](MILESTONE_SUMMARY-MONEY.md) | planned | - | none | Billing, plans, entitlements (thin) |
| [ONBOARD](MILESTONE_SUMMARY-ONBOARD.md) | planned | - | none | Stranger self-serve signup to first scheduled task (thin) |
| [AUTO](MILESTONE_SUMMARY-AUTO.md) | planned | - | none | Governed PTY autonomy + 30-night public receipts log (thin) |
| [DEBT](MILESTONE_SUMMARY-DEBT.md) | planned | - | none | Retire half-live flags (legacy waves item likely already done) (thin) |

## Evidence conflicts

- OBSRV: PROJECT.md says cancelled with 0/6 phases; PRs #309, #311, #314, #316 merged 2026-06-27.
- PTYCAP Phase 4: ROADMAP/STATE say not started; PR #506 (feat(PTYCAP-04)) is open.
- PTYCAP Phase 1: ROADMAP checkbox unchecked and progress says "In Progress" although shipped (#395) with a MAJOR accuracy gap G-1.
- PTY milestone: PROJECT.md says 2026-06-04; cutover PRs merged 2026-06-05.
- DEBT: lists "legacy waves" although BLEED notes say it is already deleted.
- ASK, WORK, ONCE, TEAB, BLEED are named in CLAUDE.md/PRs but absent from PROJECT.md "Shipped Milestones" besides BLEED.
