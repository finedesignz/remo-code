# Phase 06: Self-Heal Absorb (coolify-ai-monitor) — Context

**Gathered:** 2026-05-25
**Status:** Ready for planning
**Source:** `.planning/analysis/coolify-ai-monitor-vs-remo-code.md`
**Branch:** `feat/phase-06-self-heal-absorb`

<domain>
## Phase Boundary

Retire the standalone `coolify-ai-monitor` Express service (port 3032) by absorbing its valuable capabilities into remo-code's scheduler + self-heal pipeline. Phase 06 ships 5 features; defers 2; drops 1.

**In scope (5 absorbed features):**
1. Coolify deployment webhook ingress (`deployment.failed` / `deployment.succeeded`) → synthesized triage run
2. Regex error pre-filter on `log_check` output (16-pattern detector) — gate before LLM spend
3. Structured triage schema (`error_type`, `severity`, `root_cause`, `suggested_fix`, `confidence`) as a new `task_kind: 'triage'`
4. `github_issue` post-run action (Octokit, severity-labeled) alongside existing email/telegram/webhook
5. Deployment-event metadata (`deployment_uuid`, `application_uuid`, `git_repository`, commit SHA) on `scheduled_task_runs`

**Out of scope (deferred to Phase 07+):**
- `POST /logs/drain` push ingest — `log_check` pull already covers it with auth.

**Dropped (do not port):**
- Per-error resolve state (`PATCH /errors/:id/resolve`) — superseded by run status + acknowledged flag.
- Unauthenticated public ingress — Phase 06 uses HMAC-signed webhook secret per user.

</domain>

<decisions>
## Implementation Decisions (locked)

### Branch + sequencing
- **Branch:** `feat/phase-06-self-heal-absorb` off `main`. Already created.
- **Hard dependency:** Phase 04 plan 008 (`pickSessionTarget` + `POST /api/sessions/heal`). Phase 06 MUST NOT pre-empt the routing primitive — its synthesized triage runs route through `pickSessionTarget`. If plan 008 is unmerged at execution time, Phase 06 plans are scoped so that webhook + classifier + schema + GitHub-action ship independently, with the final wire-up plan blocked until plan 008 lands.
- **Cost cap:** All triage runs flow through `hub/src/scheduler/dispatcher.ts` `enforceCostCap` — no new fan-out paths bypass the daily cap.

### Webhook ingress (G2 + G5)
- New route: `POST /api/coolify/webhook` on hub. Public path, HMAC-signed body.
- New column: `users.coolify_webhook_secret` (TEXT, generated via `gen_random_uuid()` on demand via `POST /api/account/coolify-webhook-secret/rotate`).
- Verification: `X-Coolify-Signature: sha256=<hex>` header; constant-time compare; reject `>5 min` skew.
- Payload fields persisted: `deployment_uuid`, `application_uuid`, `git_repository`, `commit_sha`, `status` (failed/succeeded/in_progress).
- On `deployment.failed`: synthesize a one-shot scheduled-task-style run (`task_kind: 'triage'`, `target: pickSessionTarget(user)`), insert into `scheduled_task_runs`, route through dispatcher.
- On `deployment.succeeded`: insert metadata row only, no LLM spend.

### Regex pre-filter (G3)
- New utility: `hub/src/scheduler/log-classifier.ts`. Exports `classifyLog(text: string): { hasErrors: boolean; matches: Array<{pattern: string; line: string; severity: 'low'|'med'|'high'}> }`.
- Pattern set ported from `coolify-ai-monitor/src/index.js:28-87`. Patterns tagged with severity.
- Called from `hub/src/scheduler/senders/coolify.ts` after `fetchLogs`. If `hasErrors === false`, the run completes with `status: 'success'` + `output_snippet: '[no errors detected]'` and **skips post-run actions entirely** (cost-cap preservation).
- Triage runs (from webhook) bypass classifier — they're already known-failed.

### Triage schema (G6)
- New `task_kind: 'triage'` on `scheduled_tasks` (existing column accepts a string; add to type union).
- Prompt template lives in `hub/src/scheduler/triage-prompt.ts`. Forces Claude to emit JSON matching:
  ```ts
  type TriageResult = {
    error_type: string;          // e.g. "DatabaseConnectionError"
    severity: 'low' | 'medium' | 'high' | 'critical';
    root_cause: string;          // 1–3 sentences
    suggested_fix: string;       // actionable
    confidence: number;          // 0..1
    affected_files?: string[];   // optional inferred paths
  };
  ```
- Output stored in `scheduled_task_runs.output_snippet` as JSON string (column already TEXT, no schema change).
- Validation: hub parses the snippet; if JSON fails or required fields missing, mark run `status: 'failed'` with reason `triage_parse_error`.

### GitHub-issue post-run action (G4)
- New post-run action type: `github_issue`. Lives at `hub/src/scheduler/post-run/github-issue.ts`.
- Config (per scheduled task): `{ repo_full_name: 'owner/repo', labels?: string[], assignees?: string[] }`.
- Credentials: per global rule, fetch via gateway pair (`loadCredentials('github')`) — never per-app env. Token must have `issues:write` on target repo.
- Issue body: rendered from `post-run/template.ts` using triage-result fields as template vars. Severity → label (`severity:high` etc.).
- Idempotency: hash `(repo, application_uuid, deployment_uuid)`; skip if an open issue with that hash exists in last 24h.

### Deployment-event metadata (G5)
- Schema change: add nullable columns to `scheduled_task_runs`:
  - `deployment_uuid TEXT NULL`
  - `application_uuid TEXT NULL`
  - `git_repository TEXT NULL`
  - `commit_sha TEXT NULL`
- Migration: idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Populated only by triage runs from the webhook handler.

### Auth + secrets
- HMAC webhook secret per user; rotation endpoint authed by JWT.
- GitHub creds via gateway (rule #19 in CLAUDE.md). No `GITHUB_TOKEN` env var on hub.
- `COOLIFY_TOKEN` continues to drive `log_check` (unchanged).

### Retire coolify-ai-monitor
- Stop coolify-ai-monitor Coolify app at end of Phase 06 (after 1-week soak with both running in parallel).
- No data migration from Mongo — historical analyses have no actionable value.
- Update `~/.claude/CLAUDE.md` port map to remove 3032 entry (delegate to docs subagent at phase end).

### Out of scope
- Log drain push (G1) — `log_check` pull covers it; revisit only if push-latency proves to matter.
- Per-error resolve UI (G7) — drop.
- Mongo data import — drop.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Analysis (source of truth for this phase)
- `.planning/analysis/coolify-ai-monitor-vs-remo-code.md` — full gap analysis, decisions, risks

### Existing remo-code surfaces this phase extends
- `hub/src/scheduler/dispatcher.ts` — cost cap, fan-out, route
- `hub/src/scheduler/senders/coolify.ts` — log_check sender; classifier hooks here
- `hub/src/scheduler/post-run/dispatcher.ts` — post-run action dispatcher (where `github_issue` plugs in)
- `hub/src/scheduler/post-run/schema.ts` — post-run action type union
- `hub/src/scheduler/post-run/template.ts` — template var rendering
- `hub/src/db/schema.sql` — Postgres schema; migration target for new columns
- `hub/src/db/dal.ts` — DAL functions for users + scheduled_task_runs
- `docs/scheduled-tasks.md` — must be updated in same commit per CLAUDE.md scheduler rule

### Phase 04 (hard dependency for final wire-up)
- `.planning/phases/04-coolify-dev-supervisor/04-PLAN-008-self-heal-routing.md` — `pickSessionTarget` + `POST /api/sessions/heal`
- `.planning/phases/04-coolify-dev-supervisor/04-PLAN-009-cost-cap-hub-wide.md` — hub-wide cost cap

### coolify-ai-monitor reference
- `C:/Users/artic/GitHub/coolify-ai-monitor/src/index.js` — original implementation (read-only reference for regex set, prompt shape, payload fields)

### Global rules (CLAUDE.md user-global)
- Rule #7 — email always emails4agents
- Rule #17 — Postgres on Coolify (no Supabase, no Mongo)
- Rule #19 — branch hygiene; one branch one concern (already honored: this branch is fresh)
- MCP server auth — GitHub creds via gateway pair, never env

</canonical_refs>

<specifics>
## Specific Ideas

### Regex pattern port (G3)
The 16 patterns from `coolify-ai-monitor/src/index.js:28-45` — `/error/i`, `/ECONNREFUSED/`, `/ETIMEDOUT/`, `/SyntaxError/`, `/TypeError/`, `/ReferenceError/`, `/uncaught exception/i`, `/unhandled promise rejection/i`, `/fatal/i`, `/segfault/i`, `/out of memory/i`, `/EACCES/`, `/EADDRINUSE/`, `/Connection refused/`, `/permission denied/i`, `/MODULE_NOT_FOUND/`. Tag each with default severity (`med` for most, `high` for OOM/segfault/uncaught).

### Webhook signing reference
Pattern: same HMAC scheme as existing `webhook` post-run action's outbound signing (`hub/src/scheduler/post-run/webhook.ts`). Reuse the helper if one exists; otherwise extract.

### Triage prompt shape
Borrow structure from `coolify-ai-monitor/src/index.js:93-110` but enforce JSON via Claude's tool-use rather than markdown parsing. Provide last 100 log lines (already in `output_snippet` after `log_check` runs).

</specifics>

<deferred>
## Deferred Ideas

- **Log drain push ingest (G1)** — Phase 07+ if push-latency ever proves to matter. `log_check` pull is the default.
- **Multi-deployment correlation** — link a triage run to other runs touching the same `application_uuid` within 24h, surface in UI. Future polish.
- **GitHub issue auto-close** — when a follow-up run shows the error gone, close the issue. Future polish.
- **Slack/Discord post-run action** — same plumbing as `github_issue`, different transport. Out of scope here.

</deferred>

---

*Phase: 06-self-heal-absorb*
*Context gathered: 2026-05-25 from analysis doc*
