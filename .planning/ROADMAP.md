<!-- updated: 2026-05-24 -->
# Roadmap

Project: **remo-code**
Owner: jsmithfd@gmail.com
Source of truth for phase ordering, status, and dependencies. The GSD SDK parses this file — keep the `Phase NN: <slug>` heading and the `Status:` / `Goal:` / `Depends on:` / `Requirements:` lines exactly as shown.

---

## Phase 01: merge-self-heal

- Status: Complete
- Started: 2026-05-10
- Completed: 2026-05-22
- Goal: Resolve stale upstream PR #1 (`upstream-fixes`, ~14 days old, 126-file drift vs main). Cherry-pick fixes still valid on current main, drop the rest, close the PR.
- Depends on: []
- Requirements: []
- Phase dir: `.planning/phases/merge-self-heal/`
- Outcome: PR #1 closed with replacement commits. Crypto helpers extracted to `hub/src/lib/crypto.ts`. `hubFetch` added to web. Profile PATCH route shape fixed.

## Phase 02: scheduled-tasks

- Status: Complete
- Started: 2026-05-15
- Completed: 2026-05-23
- Goal: Hub-side cron scheduler that fires user-defined prompts/skills/supervisor commands against one session, one supervisor, or all-of-either, with per-target run history, daily cost cap, offline-grace replay, boot catch-up, and post-run actions (chain / email-via-emails4agents / telegram / web push / webhook with HMAC).
- Depends on: [Phase 01]
- Requirements: []
- Phase dir: `.planning/phases/scheduled-tasks/`
- Outcome: V2 dispatcher shipped at `hub/src/scheduler/`. 41 unit tests + 1 e2e smoke. Docs at `docs/scheduled-tasks.md`. Live in prod. Legacy v0 (`hub/src/scheduler/index.ts`) still wired during transition; follow-up will remove it.

## Phase 03: multichat-grid-view

- Status: Complete
- Goal: Let a user view many Claude Code sessions at once. Desktop: user-named tabs, each holding a configurable set of sessions, rendered as a resizable CSS grid (3×3, 4×3, auto-fit) with live activity in each cell. Mobile: vertical accordion list of sessions; tap-to-expand into a square chat surface with input pinned to the bottom. Tab state persists per user (survives refresh, syncs across devices). URL-routable (`#/grid/:tabId`).
- Depends on: [Phase 02]
- Requirements: [R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13]
- Phase dir: `.planning/phases/03-multichat-grid-view/`
- Plans:
  - `03-PLAN-001-schema-and-api` — wave 1 — schema (`chat_tabs`, `chat_tab_sessions`), DAL, REST endpoints
  - `03-PLAN-002-ws-multi-subscribe` — wave 1 — wire the existing multi-`session_ids` subscribe op end-to-end on the web client; enforce 12-cell cap; add per-connection set membership routing
  - `03-PLAN-003-chat-surface-refactor` — wave 2 — extract `<ChatSurface sessionId density>` with `full` / `cell` / `mobile-expanded` variants, no regression to existing single-chat
  - `03-PLAN-004-desktop-grid-page` — wave 3 — `<GridPage>` route at `#/grid` and `#/grid/:tabId`, tab bar + grid area, resize handles, session picker
  - `03-PLAN-005-mobile-accordion` — wave 3 — `<MobileAccordion>` below `md` breakpoint, square expanded panel, pinned input
  - `03-PLAN-006-polish-and-docs` — wave 4 — nav entry, README, CLAUDE.md, `docs/grid-view.md`, visual regression check

## Phase 04: coolify-dev-supervisor

- Status: Pending
- Goal: Run a lean dev-only remo-code supervisor on a Coolify server (with Claude Code CLI + git) to host self-heal sessions off the local desktop. Supervisor reports CPU/RAM/concurrency budget to hub; hub enforces concurrency + per-user daily cost cap; UI shows budget with override slider. Self-heal errors/tasks routed to this remote supervisor by preference.
- Depends on: [Phase 02]
- Requirements: []
- Phase dir: `.planning/phases/04-coolify-dev-supervisor/`
- Plans:
  - `04-PLAN-001-budget-reporting` — wave 1 — supervisor cgroup detection + `host_resources` WS message
  - `04-PLAN-002-schema-and-migration` — wave 1 — `supervisors` budget columns + `users.preferred_supervisor_id` + persistence handler
  - `04-PLAN-003-hub-concurrency-gate` — wave 2 — atomic `reserveSessionSlot`/`releaseSessionSlot`, wired into all session-creation paths
  - `04-PLAN-005-supervisor-dockerfile` — wave 2 — multi-stage `supervisor/Dockerfile`, non-root, GHCR workflow
  - `04-PLAN-007-worktree-per-session` — wave 2 — shared bare clones + `git worktree add` per session, branch-collision detection
  - `04-PLAN-006-coolify-deploy` — wave 3 — provision Coolify resource (volumes, env, no exposed ports) + runbook
  - `04-PLAN-008-self-heal-routing` — wave 3 — `POST /api/sessions/heal` + `pickSessionTarget` resolution order
  - `04-PLAN-009-cost-cap-hub-wide` — wave 3 — lift scheduler daily cost cap to hub-wide per-user gate
  - `04-PLAN-004-empirical-budget-measurement` — wave 4 — measure per-session RSS on Coolify, tune `MB_PER_SESSION`
  - `04-PLAN-010-web-budget-ui` — wave 4 — supervisor card, override slider, cost HUD, settings sections
  - `04-PLAN-011-tests-and-docs` — wave 4 — end-to-end test + docs (coolify-supervisor.md, README, CLAUDE.md)

## Phase 05: codex-cli-and-rootless-sessions

- Status: Pending
- Goal: Add Codex CLI as an alternative to Claude in the supervisor (user can pick per-session which CLI to spawn), and add a "rootless" session mode where the user can open one Claude session and one Codex session at the machine root (no repo / no project_dir required) — for ad-hoc Q&A outside any project. Also: when supervisor is installed on a new machine/server, ensure the user's persistent instructions/config (CLAUDE.md, AGENTS.md, ~/.codex/instructions.md, agent profile) are retained/seeded so the supervisor behaves identically across hosts.
- Depends on: []
- Requirements: []
- Phase dir: `.planning/phases/05-codex-cli-and-rootless-sessions/`
