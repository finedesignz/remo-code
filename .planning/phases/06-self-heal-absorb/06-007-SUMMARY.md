---
phase: 06-self-heal-absorb
plan: 007
title: GitHub-issue post-run action (G4)
status: complete
commits:
  - ff3c5ef  # schema: GithubIssueAction added to discriminated union
  - 034c61f  # executor + dispatcher wiring + DAL helpers
  - 9b6c236  # schema.sql table + 4 bun tests
files_created:
  - hub/src/scheduler/post-run/github-issue.ts
  - hub/test/post-run-github-issue.test.ts
files_modified:
  - hub/src/scheduler/post-run/schema.ts
  - hub/src/scheduler/post-run/dispatcher.ts
  - hub/src/db/dal.ts
  - hub/src/db/schema.sql
  - hub/package.json
  - bun.lock
---

# Phase 06 Plan 007: GitHub-issue Post-Run Action — Summary

Added `github_issue` as a first-class post-run action alongside `notify_email`,
`notify_telegram`, `webhook`, etc. Triage runs (Plan 006) now route a structured
failure report into a severity-labeled GitHub issue, with 24h idempotency keyed
on `(repo, application_uuid, deployment_uuid)`.

## One-liner
`github_issue` post-run action: gateway-loaded PAT + Octokit issue create + severity-derived labels + sha256 idempotency.

## What shipped
1. **Schema** (`hub/src/scheduler/post-run/schema.ts`) — new `GithubIssueAction` Zod schema added to the discriminated union. `repo_full_name` validated `owner/repo`; `labels`/`assignees` optional with max caps.
2. **Executor** (`hub/src/scheduler/post-run/github-issue.ts`) — loads PAT from gateway pair (Ottolax → claude-gateway fallback), parses `output_snippet` as a `TriageResult`, falls back to a generic body on parse failure, builds title/body via the existing `render()` templater, calls Octokit `issues.create`. **Zero env-var credentials** — passes `grep -n "GITHUB_TOKEN" hub/src/` (the only hit is the comment explaining why).
3. **Idempotency** — sha256(`${repo}|${app_uuid}|${deploy_uuid}`) over a 24h window. Helpers `hasOpenIssueForHash` / `recordOpenIssueForHash` added to `hub/src/db/dal.ts`. Backed by new `github_issue_idempotency` table (PK `(user_id, hash)`, idempotent `CREATE TABLE IF NOT EXISTS`).
4. **Dispatcher wiring** — `executeAction` switch in `hub/src/scheduler/post-run/dispatcher.ts` routes `case 'github_issue'` to the new executor with `{ userId, templateVars, runId }`.
5. **Labels** — combined: user-config labels ∪ `[severity:<level>, automated, remo-code]`.
6. **Tests** — `hub/test/post-run-github-issue.test.ts` (4 tests, no DB needed):
   - creates issue on first call
   - second identical call is deduped (Octokit invoked once)
   - missing gateway token → skipped, no Octokit call
   - non-`github_issue` actions are ignored
   All pass: `bun test test/post-run-github-issue.test.ts` → **4 pass, 0 fail**.

## Deviations
- **Rule 2 (missing critical functionality):** Plan task 2 referenced `ctx.templateVars.application_uuid` and `deployment_uuid`, but `buildContext()` in `post-run/dispatcher.ts` does NOT populate those keys (they live on the run row, not the task). Rather than expand the templateVars surface for every post-run action, the executor falls back to `getRun(runId, userId)` to load deployment metadata directly off `scheduled_task_runs`. Contained to `github-issue.ts`; no churn in shared dispatcher contracts.
- **Pre-existing TS narrowing error in `dispatcher.ts:74`** (`parsed.errors` on a discriminated union result) is NOT introduced by this plan and is out of scope (SCOPE BOUNDARY).

## Verification checklist
- [x] `bun test test/post-run-github-issue.test.ts` green (4/4)
- [x] `grep -n "GITHUB_TOKEN" hub/src/` returns only a comment line
- [x] `grep -n "github_issue" hub/src/scheduler/post-run/dispatcher.ts` shows the new switch case
- [x] `bunx tsc --noEmit … github-issue.ts` clean (no new errors)
- [x] Per-task atomic commits

## Self-Check: PASSED
- `hub/src/scheduler/post-run/github-issue.ts` — present
- `hub/test/post-run-github-issue.test.ts` — present (4/4 green)
- Schema table `github_issue_idempotency` — present in `hub/src/db/schema.sql`
- Commits `ff3c5ef`, `034c61f`, `9b6c236` — present on `feat/phase-06-self-heal-absorb`

## Threat Flags
None — outbound HTTPS only to gateway + api.github.com; credentials never logged; no new ingress.
