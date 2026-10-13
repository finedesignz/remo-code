# Milestone Summary: v1.0 (14 phases)

Status: SHIPPED, archived 2026-06-02. Evidence: `milestones/v1.0-MILESTONE.md`, `v1.0-ROADMAP.md`, `v1.0-REQUIREMENTS.md`, `milestones/legacy-phases/`, PR history. Artifacts: partial (see Tech Debt).

## 1. Overview

First milestone of remo-code: a web app to chat with local Claude Code / Codex CLI sessions from any browser or phone, backed by a Bun + Hono hub and a local Tauri supervisor. Roadmap phases ran from 2026-05-10 (Phase 01 start) to roughly 2026-05-31; the milestone was reconciled and archived on 2026-06-02 (PR #242). The repo itself dates from 2026-03-20 (initial commit).

## 2. Architecture

Browser SPA (React 19 + Vite + Tailwind 4) <-> hub (Bun + Hono, port 3040, Postgres) <-> `/ws/agent` <-> Tauri supervisor <-> `claude`/`codex` CLI subprocess. Key v1.0 structures: v2 scheduler (`hub/src/scheduler/`), shared dispatch pipeline and webhook intake deep modules (PRs #154, #155, #165-#175), runner abstraction for Codex, Titanium magic-link + opaque cookie auth.

## 3. Phases

| # | Phase | Outcome (from v1.0-ROADMAP / legacy-phases) |
|---|-------|---------------------------------------------|
| 01 | merge-self-heal | Stale upstream PR #1 closed with replacement commits; crypto helpers extracted |
| 02 | scheduled-tasks | V2 cron dispatcher, 41 unit tests, `docs/scheduled-tasks.md` |
| 03 | multichat-grid-view | Grid of up to 12 sessions, tabs, mobile accordion (PR #3) |
| 04 | coolify-dev-supervisor | Lean dev supervisor on Coolify, budget reporting, concurrency gate |
| 05 | codex-cli-and-rootless-sessions | Codex runner, rootless ambient sessions |
| 06 | supervisor-tray-app | Tauri tray app, installer, autostart |
| 07 | titanium-auth-cutover | Titanium magic-link + license gate (ROLLOUT / TEST-MATRIX docs) |
| 08 | design-system-foundation | Accent to blue, Button/Card/InfoTip primitives (PR #205) |
| 09 | connections-overhaul | Orchestrator top row, roots to wizard (PR #206) |
| 10 | prompts-removal-and-per-session-nudge | Prompts tab deleted, per-session auto-nudge (PR #207) |
| 11 | usage-tab-cleanup | Merged usage + cost card (PR #208) |
| 12 | profile-and-default-session | Profile autosave, default session (PR #210) |
| 13 | grid-view-active-sessions | Default grid tab = all active sessions (PR #209) |
| 14 | settings-docs-and-polish | Architecture docs refresh (PR #211) |

Phases 08-14 are the "v-settings-overhaul" sub-milestone (PRs #204-#211, 2026-05-30).

## 4. Decisions

- Built and deployed through the direct-PR workflow, not the GSD lifecycle (v1.0-MILESTONE.md reconciliation note).
- Postgres self-hosted on Coolify; `schema.sql` is idempotent DDL re-run every boot.
- Accent color blue, never indigo (CI-enforced by `web/test/no-indigo.test.ts`, per CLAUDE.md).
- Source of truth for what shipped is git history + `docs/*.md`.

## 5. Requirements

`v1.0-REQUIREMENTS.md` is a snapshot; Phase 03 maps R01-R13. Other phases list no REQ-IDs. Coverage cannot be audited from artifacts (inferred: delivered via PRs).

## 6. Tech Debt

- Per-phase SUMMARY/PLAN files for most phases are 300-400 byte reconciliation stubs, not build-time records. Artifacts thin.
- Live ROADMAP.md / REQUIREMENTS.md intentionally retained un-collapsed after archive.
- Mobile Tauri client (PRs #152, #158, #161, #162) paused 2026-05-28; dormant.

## 7. Getting Started

Read `CLAUDE.md`, `docs/claude-architecture-notes.md`, `docs/scheduled-tasks.md`, `docs/grid-view.md`, `docs/auth.md`. Run `bun install`, `bun run dev:hub`, `bun run dev:web`; gate with `bun run check-baseline`.
