# Milestone Summary: GOV (Governance Surface)

Status: PLANNED (item 4 in PROJECT.md Planned Milestones). Artifacts thin: one-line scope only; no requirements or roadmap file.

## 1. Overview

The governance surface that is the product being sold: org spend ledger, policy caps, audit, kill switch, receipts page. PROJECT.md: "sell the governor, not the engine".

## 2. Architecture (planned)

Builds on existing ledgers (`token_usage`, `routine_run_log`, `session_runs`). The OBSRV run-log read API plus Activity panel are intended to become the receipts page (OBSRV cancellation note).

## 3. Phases

None defined.

## 4. Decisions

Open-core line: paid tier = teams/SSO/RBAC, org spend ledger + policy caps, audit log with retention, org-wide kill switch, hosted/SLA. Never gate on session count; never paywall the orchestrator.

## 5. Requirements

None on disk.

## 6. Tech Debt / Risks

PROJECT.md "Untested Assumption": nobody has paid for this; the $99/mo team waitlist test (r/ClaudeAI + HN) has not been run and should precede MONEY.

## 7. Getting Started

Start after PTYCAP; the Phase 4 kill switch is the first building block.
