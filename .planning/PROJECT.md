<!-- updated: 2026-06-25 -->
# Project — remo-code

## What This Is

Web app to chat with local Claude Code / Codex CLI sessions from any browser or phone. A local
**Tauri Supervisor** (MSI, one per host) spawns the CLI and relays activity to a **hub** (Bun + Hono,
port 3040) over `/ws/agent`; browsers connect to `/ws/client`. Live in prod at **https://app.remo-code.com**
(Coolify, Docker). Open-source: `finedesignz/remo-code`. Full architecture + invariants in `CLAUDE.md`
and `.planning/STATE.md`.

## Core Value

Remote, full-visibility control of persistent local coding-agent sessions (thinking, tool calls,
streaming text, scheduled tasks, grid view, Telegram bridge, error-capture self-heal) with a
non-bypassable daily cost cap and Titanium-aligned auth.

## Shipped Milestones

- **v1.0** (Phases 01–14) — shipped + archived 2026-06-02 (`.planning/milestones/v1.0-*`).
- **m-interactive-pty-runner** (Phases 15–20) — shipped + live 2026-06-04. Interactive `claude`/`codex`
  PTY terminal is the default web/phone human surface. Cutover-flip + ChatSurface deletion DEFERRED
  on a postponed Anthropic billing measurement (`docs/cutover-gate-june15.md`).
- **TMAC** (Phases TMAC-01..06) — built + merged 2026-06-08. Autonomous task-type macro prompt path is
  the default orchestrator cycle-runner; legacy micro-row wave engine kept behind a rollback flag.

## Planned Milestones (Roadmap)

This is the **ONLY** source the autonomous auto-dev orchestrator may draw the next milestone
from. Entries are **owner-curated** (added here deliberately by the owner, never invented by the
orchestrator); ordered top = next. When the current milestone ships and this list is empty, the
orchestrator must STOP and request owner direction — it may NOT self-scope a novel product direction.

- _(none planned — orchestrator must STOP and request direction when the current milestone ships)_

## Current Milestone: OBSRV — Orchestrator Observability & Shadow Dry-Run

**Goal:** Build the read-only observability + safety-rehearsal layer for the auto-dev/autospawn path
*before* the owner arms it (`REMO_ORCHESTRATOR_AUTOSPAWN=1`). ZERO behavior changes to the live dispatch
path — pure additive read/shadow work over seams OEE already proved, so the eventual arming decision is
informed and reversible.

**Target features:**
- Surface the existing `routine_run_log` in the web UI — per-session "Auto-Dev Activity" panel + hub-wide
  orchestrator run feed (rationale, command, outcome, PR url, reviewer verdict, deploy-verify, cost/tokens)
  via a new read-only `GET /api/orchestrator/run-log`.
- Autospawn SHADOW dry-run — flag-gated `REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW=1` path where `inject.ts`
  `maybeAutospawnOffline` runs the FULL gate/allowlist/cap AND-chain and records the would-be spawn+macro
  prompt WITHOUT calling `launchSessionForUser` or dispatching (guard test asserts no spawn/dispatch).
- Orchestrator metrics + cap-approach alerting — extend `hub/src/observability/metrics.ts` with orchestrator
  counters (cycles enqueued/drained/skipped, skip-reason histogram incl `no_session`/`offline`, dispatch
  outcomes, daily token+cost vs the 50M/`$` ceilings) + stage-gated `notify.ts` fan-out at a configurable %.

**Out of scope (owner gates — keep out):** flipping `REMO_ORCHESTRATOR_AUTOSPAWN=1` / populating the
allowlist (shadow mode is the deliberate substitute), changing any cap *behavior* in `dispatch/gates.ts`,
touching the no-auto-merge guard, any destructive migration (additive idempotent DDL only), and redesigning
the supervisor-invisible-local-build session model.

**Requirements:** `.planning/REQUIREMENTS.md` (OBSRV-NN).

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state
