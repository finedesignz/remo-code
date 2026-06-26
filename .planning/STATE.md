---
gsd_state_version: 1.0
milestone: OEE
milestone_name: Orchestrator E2E Prove-Out
status: planning
last_updated: "2026-06-26T05:17:19.259Z"
last_activity: 2026-06-26
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

<!-- updated: 2026-06-14 -->

# Project State — remo-code

> **GSD stats reconciled 2026-06-14 (PTY + orchestrator/TMAC).** Phases 15–32 shipped via the
> direct-PR workflow; GSD per-phase status reconciled to match (PLAN.md placeholders for 15–20 +
> `status: passed` on the 16/21/22 verification reports). `gsd-sdk query stats.json` now reports
> 20/32 phases Complete (63%) with NO phase 15–32 left "Not Started" (was 12/32, 38%).

> **v1.0 reconciled + archived 2026-06-02.** All 14 v1.0 phases shipped to prod via the
> direct-PR workflow (not the GSD lifecycle); GSD state reconciled (per-phase SUMMARY/PLAN
> stubs + ROADMAP statuses → Complete) and the milestone archived to
> `.planning/milestones/v1.0-{MILESTONE,ROADMAP,REQUIREMENTS}.md`.
> `gsd-sdk query init.milestone-op` → `completed_phases: 14/14`, `all_phases_complete: true`.

> **Reconstructed 2026-05-29.** The prior STATE.md was stale at Phase 03 (2026-05-24).
> Repo is ~10 phases ahead. Source of truth for live detail is `docs/*.md` + git log.

## What it is

Web app to chat with local Claude Code / Codex CLI sessions from any browser or phone.
A local **Tauri Supervisor** (MSI, one per host) spawns the CLI with `--input-format
stream-json --output-format stream-json` and relays activity to a **hub** (Bun + Hono,
port 3040) over `/ws/agent`. Browsers connect to `/ws/client`. Live in prod at
**https://app.remo-code.com** (Coolify, Docker). Open-source: `finedesignz/remo-code`.

Legacy `npx remo-code-agent` / `claude-remote` retired (Phase 09). Only supported
connection is the Tauri Supervisor MSI.

## Packages (Bun workspace)

- **hub/** — Bun + Hono HTTP + WS. Titanium magic-link + opaque-cookie auth (see auth note
  below), Postgres-backed sessions/messages/api_keys, shared dispatch pipeline
  (`hub/src/dispatch/`), serves built SPA static.

- **web/** — React 19 + Vite + Tailwind 4 SPA, hash routing.
- **supervisor/** — Tauri tray app; `supervisor/src/` Bun TS compiled to a sidecar binary.

## Current position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-06-26 — Milestone OEE started

### Phase ledger (`.planning/phases/`)

03 multichat-grid-view · 04 coolify-dev-supervisor · 05 codex-cli-and-rootless ·
06 error-capture / self-heal-absorb / supervisor-tray · 07 titanium-auth-cutover ·
08 github-session-keying / revanote-integration · 09 retire-npm-packages ·
11 structured-task-workflows · 12 mobile-tauri-client (PAUSED) / telegram-bridge / ui-restructure.

## Auth reality (important)

Prod runs `TITANIUM_BYPASS=true` — the Phase-07 Titanium magic-link cutover is BLOCKED on
Keygen CE having no JWKS endpoint (`.planning/debug/phase-07-jwks-blocker.md`; pivot options
documented, not yet executed). While bypassed, **both magic-link endpoints hard-return
`503 titanium_disabled`** (`hub/src/api/auth.ts:174,221`). Login therefore runs through the
**legacy bcrypt path** (`POST /api/auth/login`), which IS enabled in prod (`ALLOW_LEGACY_LOGIN`).
Web Login (`web/src/pages/Login.tsx`) supports both modes + magic-link-disabled fallback (#188).

Prod has exactly ONE user: `articulatedesigns@gmail.com` (admin, display "Michael"). Password
reset 2026-05-29 to unblock owner login. `jamie@theleadingpractice.com` is NOT a DB row.

## Active / pending work

- ✅ **Telegram bridge UX fix** — MERGED #189 (`0050cf4`), deployed + smoke-verified 2026-05-29.
  Fix A `setMyCommands` slash menu, Fix B navigator hardening (no handler was actually dropped —
  it only looked broken w/o the slash menu; pagination hardcode → `PAGE_SIZE`), Fix C inline
  tap-to-approve permission prompts (`hub/src/telegram/approvals.ts`, `events/permission-events.ts`).
  Security-reviewed SHIP. **Open fast-follow (MED, fails-closed, moot at 1 user):** pending-prompt
  registry keys by `requestId` alone → shared-session collision; key by `sessionId+requestId` +
  set of authorized userIds. Functional verify (slash menu render, live approve/deny) needs a real
  Telegram session — user-testable.

- 🟢 **Hub-deepening Round 2** — UNBLOCKED (Telegram PR landed). Subsystem migrations onto shared
  `hub/src/dispatch/`. Round 1 foundations merged (#154/#155/#156). Coordinate before editing
  `hub/src/{scheduler,error-capture,revanote,telegram,ws/agent}`. Note redundant sibling branch
  `fix/telegram-three-bugs` (worktree `.claude/worktrees/tg-slash-nav`, #188) from another session
  — superseded by #189, candidate for cleanup.

- ⏸️ **Phase 12 mobile (Tauri)** — PAUSED 2026-05-28. Resume doc `docs/phase-12-pause-state.md`.
  iOS never built; working MSI + APK exist.

## Cross-cutting invariants (do not violate)

- Cost cap non-bypassable — all user→session dispatch via `hub/src/dispatch/gates.ts`.
- Public webhooks: raw body before JSON parse, constant-time secret compare, mount BEFORE
  `/api/*` auth catch-all (`hub/test/mount-order.test.ts` enforces).

- `schema.sql` re-runs every boot — idempotent DDL only; backfills → `hub/scripts/` one-shots.
- Orchestrator: exactly one open per user (`idx_sessions_orchestrator_unique`).
- QC gate: `bun run check-baseline` (per-file test isolation; `tools/regression-baseline.json`).
