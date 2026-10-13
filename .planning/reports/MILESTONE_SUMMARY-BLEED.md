# Milestone Summary: BLEED (stop-the-bleed, four independent fixers)

Status: SHIPPED; reconciled as closed 2026-09-28 (PR #492). Fix PRs merged 2026-07-09 to 2026-07-12. Artifacts thin: no milestone directory or phase files; summarized from PROJECT.md "Shipped Milestones", CLAUDE.md and PR history.

## 1. Overview

On 2026-07-11 a runaway orchestrator loop burned 2.83 billion cache-read tokens in two days and killed the owner's Claude Max subscription. The cap existed but was blind to cache-read, and an audit found `dailyTokenCapGate` rode only the orchestrator inject path, leaving six other dispatch paths unbounded. BLEED closed the critical leaks and proved the caps fire.

## 2. Architecture

Four fixers, each verified against `main` (`b69a6f9`) by code inspection per PROJECT.md:
1. Run leak: NULL-`session_id` fix in `hub/src/db/supervisor-dal.ts` plus absolute-age reaper `hub/src/sessions/stale-run-reaper.ts`.
2. Supervisor circuit breaker half-opens with cooldown and reports state (`supervisor/src/process-manager.ts`).
3. `dailyTokenCapGate` on all seven dispatch paths, proven against real Postgres (`token-cap-coverage.test.ts`, `token-cap-gate-fires.test.ts`).
4. `schema.sql` CI-fenced against mutating statements; ghost-hostname churn rejected at source (`4001 hostname_required`); legacy waves flag deleted.

## 3. Phases

Four fixers, not numbered phases. PRs: #328 (stale in-flight lock reaper), #330 (ghost sessions), #342 (cap counts cache tokens + inject-rate ceiling), #343 (stop per-tick re-inject), #344 (scheduler fixes), #346 (stop-the-bleed main PR, 2026-07-12), #492 (reconcile docs, 2026-09-28).

## 4. Decisions

- Token cap counts all four buckets (input, output, cache_creation, cache_read); default 50M/day; fails closed (hub refuses to boot on a bad value).
- Per-session inject-rate ceiling default 4/hr.
- Reaper predicate is positive knowledge scoped per supervisor, never age alone.

## 5. Requirements

No REQUIREMENTS file. Regression baseline floor now `pass_min: 1850` vs measured `pass=2157 fail=0` (PROJECT.md, 2026-09-28).

## 6. Tech Debt

PROJECT.md and STATE.md had drifted about 2.5 months stale until #492. Remaining half-live flags are tracked as the planned DEBT milestone.

## 7. Getting Started

Read `docs/claude-architecture-notes.md`, CLAUDE.md "Cost cap is non-bypassable", and the two token-cap tests above.
