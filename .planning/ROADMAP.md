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
