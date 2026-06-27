---
phase: 06-self-heal-absorb
plan: 001
type: execute
wave: 1
depends_on: []
files_modified:
  - hub/src/db/schema.sql
autonomous: true
requirements: []

must_haves:
  truths:
    - "users table has coolify_webhook_secret column for HMAC verification"
    - "scheduled_task_runs has deployment_uuid, application_uuid, git_repository, commit_sha nullable columns"
    - "Schema re-runs on existing DBs without error (idempotent)"
  artifacts:
    - path: "hub/src/db/schema.sql"
      provides: "Idempotent ALTER TABLE statements for Phase 06 columns"
      contains: "coolify_webhook_secret"
  key_links:
    - from: "users.coolify_webhook_secret"
      to: "POST /api/coolify/webhook HMAC verify (plan 004)"
      via: "per-user signing secret"
---

<objective>
Add schema columns for Phase 06: per-user Coolify webhook HMAC secret on `users`, deployment-event metadata on `scheduled_task_runs`. All migrations idempotent `ADD COLUMN IF NOT EXISTS`.

Purpose: Storage layer prerequisite for webhook ingress (plan 004) and triage runs (plan 006). Ships independently — no code references the new columns yet.
Output: Updated `hub/src/db/schema.sql`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@hub/src/db/schema.sql
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add users.coolify_webhook_secret + scheduled_task_runs deployment metadata columns</name>
  <files>hub/src/db/schema.sql</files>
  <read_first>
    - hub/src/db/schema.sql (full file — find existing ALTER TABLE blocks for `users` and `scheduled_task_runs` to colocate new statements)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md (decisions: "Auth + secrets", "Deployment-event metadata")
  </read_first>
  <action>Append to `hub/src/db/schema.sql` near the existing `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...` block: `ALTER TABLE users ADD COLUMN IF NOT EXISTS coolify_webhook_secret TEXT;` (nullable — generated on demand by rotation endpoint per D from CONTEXT.md "Webhook ingress"). Near the `scheduled_task_runs` table definition (find by `CREATE TABLE IF NOT EXISTS scheduled_task_runs`), append four idempotent ALTERs: `ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS deployment_uuid TEXT;`, `... application_uuid TEXT;`, `... git_repository TEXT;`, `... commit_sha TEXT;`. Also add an index for lookup by application_uuid: `CREATE INDEX IF NOT EXISTS idx_str_application_uuid ON scheduled_task_runs(application_uuid) WHERE application_uuid IS NOT NULL;`. Do NOT add new tables. Do NOT modify existing column types. No code/DAL changes in this plan.</action>
  <verify>
    <automated>cd hub ; bun run -e "import('./src/db/postgres.ts').then(m => m.sql.unsafe(require('fs').readFileSync('src/db/schema.sql','utf8'))).then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"</automated>
  </verify>
  <done>schema.sql re-runs cleanly against an existing DB; `\d users` shows `coolify_webhook_secret`; `\d scheduled_task_runs` shows the four new columns plus the index.</done>
</task>

</tasks>

<verification>
- `psql $DATABASE_URL -c "\d users"` lists `coolify_webhook_secret text`.
- `psql $DATABASE_URL -c "\d scheduled_task_runs"` lists `deployment_uuid`, `application_uuid`, `git_repository`, `commit_sha` text columns.
- Running schema.sql twice in a row produces no errors.
</verification>

<success_criteria>
- All five new columns exist as nullable TEXT.
- Index `idx_str_application_uuid` exists.
- No other tables/columns altered.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-001-SUMMARY.md` when done.
</output>
