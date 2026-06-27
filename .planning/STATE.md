---
gsd_state_version: 1.0
milestone: OBSRV
milestone_name: Orchestrator Observability & Shadow Dry-Run
status: roadmapped
last_updated: "2026-06-27T12:16:13.375Z"
last_activity: 2026-06-27
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

<!-- updated: 2026-06-27 -->

> **Milestone OBSRV roadmapped 2026-06-27.** 6 phases (OBSRV-01..06), fine granularity, all
> milestone-scoped dirs under `.planning/phases/OBSRV-NN-slug/`. 14/14 requirements mapped
> (RUNLOG/SHADOW/METRIC/HARDEN). Pure additive read/shadow work — ZERO live-dispatch behavior
> change, no `gates.ts` cap-behavior change, no AUTOSPAWN flip / allowlist populate, no
> no-auto-merge-guard touch, additive idempotent DDL only. Parallel-startable now: Phase 1
> (run-log read API) + Phase 3 (metrics counters). See `.planning/ROADMAP.md`.

> **Milestone OEE (Orchestrator E2E Prove-Out) SHIPPED + LIVE 2026-06-26.** All 10 phases
> (OEE-01..10) built + merged (PR #300, docs closeout #301). An isolated e2e harness +
> scripted sentinel session sink + 8 scenario suites (`hub/test/e2e/`) now PROVE the
> flag-gated-OFF Auto-Dev Orchestrator + TMAC macro path end-to-end against REAL Postgres —
> the Woodpecker qc gate runs them against its `postgres:16` service (`REMO_E2E_DB_URL`), so
> GREEN CI = the standing proof (queue/lock, due→waves, macro-cycle+sentinels, non-bypassable
> cost-cap, stage-gated notify, verify-tail, legacy-wave rollback parity). Zero `hub/src`/
> `schema.sql` changes — pure validation via existing DI seams. Prod verified healthy
> (/health 200, /api/sessions 401, /openapi.json 200). Real-PG e2e is no longer "unproven".
> NB: `REMO_ORCHESTRATOR_ENABLED=1` is ALREADY live in prod (monitoring mode) — OEE proves the
> macro machinery, it did not flip the flag. The remaining gap is architectural, not a flag:
> the macro path only drives ONLINE supervisor-connected sessions (owner's local builds are
> invisible to the hub → never produces a PR). See the overnight-autonomy reality note.

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

Phase: Not started (roadmap complete — OBSRV-01..06 ready to plan)
Plan: —
Status: Roadmapped — next `/gsd-plan-phase 1` (or plan 1 + 3 in parallel)
Last activity: 2026-06-27 — Milestone OBSRV roadmapped (6 phases)

### OBSRV phase ledger (`.planning/phases/`)

- OBSRV-01-run-log-read-api — RUNLOG-01,02 — read-only `GET /api/orchestrator/run-log` + OpenAPI. No deps.
- OBSRV-02-web-auto-dev-activity — RUNLOG-03,04 — per-session timeline + hub-wide feed (UI). Dep: 1.
- OBSRV-03-orchestrator-metrics — METRIC-01,02 — counters + skip-reason histogram + cap headroom. No deps.
- OBSRV-04-autospawn-shadow-dry-run — SHADOW-01..04 — shadow records, no spawn/dispatch, guard test. Dep: 1.
- OBSRV-05-cap-approach-alerting — METRIC-03 — throttled stage-gated notify at % of cap. Dep: 3.
- OBSRV-06-e2e-hardening-docs-release — HARDEN-01..03 — real-PG e2e, docs, version bump, ship+smoke. Dep: 1–5.

Parallel-startable now: Phase 1 + Phase 3 (no deps).

### Prior phase ledger (shipped)

03 multichat-grid-view · 04 coolify-dev-supervisor · 05 codex-cli-and-rootless ·
06 error-capture / self-heal-absorb / supervisor-tray · 07 titanium-auth-cutover ·
08 github-session-keying / revanote-integration · 09 retire-npm-packages ·
11 structured-task-workflows · 12 mobile-tauri-client (PAUSED) / telegram-bridge / ui-restructure ·
15–20 interactive-pty-runner · 21–32 auto-dev-orchestrator/TMAC · BSA-01..08 · OEE-01..10.

## Auth reality (important)

Prod runs `TITANIUM_BYPASS=true` — the Phase-07 Titanium magic-link cutover is BLOCKED on
Keygen CE having no JWKS endpoint (`.planning/debug/phase-07-jwks-blocker.md`; pivot options
documented, not yet executed). While bypassed, **both magic-link endpoints hard-return
`503 titanium_disabled`** (`hub/src/api/auth.ts:174,221`). Login therefore runs through the
**legacy bcrypt path** (`POST /api/auth/login`), which IS enabled in prod (`ALLOW_LEGACY_LOGIN`).
Web Login (`web/src/pages/Login.tsx`) supports both modes + magic-link-disabled fallback (#188).

Prod has exactly ONE user: `articulatedesigns@gmail.com` (admin, display "Michael"). Password
reset 2026-05-29 to unblock owner login. `jamie@theleadingpractice.com` is NOT a DB row.

## Cross-cutting invariants (do not violate)

- Cost cap non-bypassable — all user→session dispatch via `hub/src/dispatch/gates.ts`. **OBSRV must
  not change cap behavior here — read counters only.**
- Public webhooks: raw body before JSON parse, constant-time secret compare, mount BEFORE
  `/api/*` auth catch-all (`hub/test/mount-order.test.ts` enforces).
- `schema.sql` re-runs every boot — idempotent DDL only; backfills → `hub/scripts/` one-shots.
- Orchestrator: exactly one open per user (`idx_sessions_orchestrator_unique`).
- QC gate: `bun run check-baseline` (per-file test isolation; `tools/regression-baseline.json`).
- **OBSRV-specific:** shadow mode NEVER calls `launchSessionForUser` / never dispatches; never flip
  `REMO_ORCHESTRATOR_AUTOSPAWN`, never populate `orchestrator_autospawn_allowlist`, never touch the
  no-auto-merge guard; additive idempotent DDL only.
