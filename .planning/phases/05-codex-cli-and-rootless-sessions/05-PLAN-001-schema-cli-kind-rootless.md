---
phase: 05-codex-cli-and-rootless-sessions
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - hub/src/db/schema.sql
  - hub/src/db/dal.ts
autonomous: true
requirements:
  - P05-CLI-KIND
  - P05-ROOTLESS-SCHEMA
must_haves:
  truths:
    - "sessions table has cli_kind column constrained to ('claude','codex'), default 'claude'"
    - "sessions table has is_rootless boolean column, default false"
    - "sessions table has hostname column (nullable, populated for rootless rows)"
    - "Per (user_id, hostname, cli_kind) at most one rootless non-deleted session can exist"
    - "Existing rows backfill cli_kind='claude', is_rootless=false without errors"
    - "DAL exposes createSession(cli_kind, is_rootless, hostname) and findOrCreateRootlessSession(user_id, hostname, cli_kind)"
  artifacts:
    - path: "hub/src/db/schema.sql"
      provides: "cli_kind, is_rootless, hostname columns + partial unique index"
      contains: "idx_sessions_rootless_unique"
    - path: "hub/src/db/dal.ts"
      provides: "findOrCreateRootlessSession + extended createSession signature"
  key_links:
    - from: "hub/src/db/schema.sql"
      to: "sessions table"
      via: "ALTER TABLE ADD COLUMN IF NOT EXISTS (idempotent migration on boot via hub/src/db/migrate.ts)"
      pattern: "ADD COLUMN IF NOT EXISTS cli_kind"
---

<objective>
Add the schema foundations for Phase 05: per-session CLI selection (`cli_kind`) and rootless ambient sessions (`is_rootless`, `hostname`, partial unique index). Update the DAL so the rest of the phase can build on these primitives without further schema churn.

Purpose: Wave 2 (runner abstraction) and Wave 3 (UI + seed) both depend on `cli_kind` being a first-class column. Rootless lookup needs a uniqueness guarantee enforced at the DB layer so race conditions during multi-agent connect can't produce duplicate ambient sessions.

Output: Migrated schema + DAL functions ready to be called by the protocol/API layer in Plan 002.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-RESEARCH.md
@hub/src/db/schema.sql
@hub/src/db/dal.ts
@hub/src/db/migrate.ts
@CLAUDE.md
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Add cli_kind, is_rootless, hostname columns + partial unique index</name>
  <files>hub/src/db/schema.sql</files>
  <read_first>
    - hub/src/db/schema.sql (sessions table — lines 15-27, observe existing ALTER patterns lines 54-76)
    - hub/src/db/migrate.ts (confirm schema.sql is executed verbatim on boot)
  </read_first>
  <action>
    Append three idempotent ALTERs and one partial unique index after the existing `idx_sessions_user_project` block (keep with related session migrations near the existing `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deleted_at` group):

    1. `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_kind TEXT NOT NULL DEFAULT 'claude'` then a separate `DO $$ BEGIN ... END $$` block (or `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS` via `information_schema` guard) that adds the CHECK constraint `cli_kind IN ('claude','codex')` only when missing. Use the existing `DO $$` patterns already in the file if any; otherwise wrap in `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name='sessions_cli_kind_check') THEN ALTER TABLE sessions ADD CONSTRAINT sessions_cli_kind_check CHECK (cli_kind IN ('claude','codex')); END IF; END $$;`.
    2. `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_rootless BOOLEAN NOT NULL DEFAULT false`.
    3. `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS hostname TEXT`.
    4. `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_rootless_unique ON sessions(user_id, hostname, cli_kind) WHERE is_rootless = true AND deleted_at IS NULL;`.

    Add a comment block above explaining: cli_kind chooses which CLI the agent spawns; is_rootless marks ambient sessions (no project_dir, one per host per CLI); partial unique index enforces "at most one rootless per (user, host, cli_kind)" while allowing many soft-deleted historical rows.

    Do NOT remove or modify existing columns. Do NOT drop the existing `idx_sessions_user_project` index — rootless lookup uses the new partial index, project sessions still use the old one.
  </action>
  <verify>
    <automated>cd hub; bun run -e "import('./src/db/migrate.ts').then(m => m.migrate()).then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1) })"</automated>
    Then: psql $DATABASE_URL -c "\d sessions" must show cli_kind, is_rootless, hostname columns and the idx_sessions_rootless_unique index. Run the migration a second time — it must succeed (idempotent).
  </verify>
  <done>
    All three columns + partial unique index present in sessions table. Re-running migrate.ts produces no error. `\d sessions` confirms CHECK constraint on cli_kind. Existing rows show cli_kind='claude', is_rootless=false.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: Extend DAL — createSession signature + findOrCreateRootlessSession</name>
  <files>hub/src/db/dal.ts</files>
  <read_first>
    - hub/src/db/dal.ts (locate current createSession + findOrCreateAgentSession; mirror their query/parameter style)
    - hub/src/db/schema.sql (the columns just added)
  </read_first>
  <action>
    Update `createSession` to accept optional `cli_kind: 'claude' | 'codex'` (default 'claude') and `is_rootless: boolean` (default false) and `hostname: string | null` (default null). Add the new columns to the INSERT and the RETURNING list. Keep the existing positional arg order; append the new args at the end so existing call sites continue to compile.

    Add a new exported function:
    `findOrCreateRootlessSession(userId: string, hostname: string, cliKind: 'claude' | 'codex', tokenHashIfCreating: string, nameIfCreating: string): Promise<SessionRow>`.
    Implementation: SELECT from sessions WHERE user_id=$1 AND hostname=$2 AND cli_kind=$3 AND is_rootless=true AND deleted_at IS NULL. If found, return it. Otherwise INSERT with `is_rootless=true, project_dir=NULL, hostname=$hostname, cli_kind=$cliKind, token_hash=$tokenHashIfCreating, name=$nameIfCreating`. Wrap in `ON CONFLICT DO NOTHING` against the partial unique index, then re-SELECT to cover the race where two agents connect simultaneously.

    Extend the SessionRow type (wherever it's declared in dal.ts or co-located types file) to include `cli_kind`, `is_rootless`, `hostname`. Update `listSessions` SELECT to include these three columns in its projection so the API returns them.

    Do NOT change findOrCreateAgentSession's existing signature; it continues to handle project sessions only.
  </action>
  <verify>
    <automated>cd hub; bun test test/dal.test.ts 2>$null; bun run tsc --noEmit -p .</automated>
    TypeScript must compile cleanly. If a `test/dal.test.ts` exists, all tests pass. Manually: call `findOrCreateRootlessSession(userId, 'host-a', 'claude', hash, 'Claude (ambient)')` twice in a row — must return the same row id both times.
  </verify>
  <done>
    `createSession` accepts new optional args without breaking existing call sites. `findOrCreateRootlessSession` exists, is idempotent, and respects the partial unique index. `listSessions` returns cli_kind, is_rootless, hostname on every row. `bun run tsc --noEmit` is green across hub/.
  </done>
</task>

</tasks>

<verification>
- `psql -c "\d sessions"` shows cli_kind (text, NOT NULL, default 'claude'), is_rootless (bool, NOT NULL, default false), hostname (text, nullable), and idx_sessions_rootless_unique partial index
- Idempotent migration: running migrate.ts twice produces no error
- DAL TypeScript compiles; existing call sites unchanged
- Backfill: `SELECT count(*) FROM sessions WHERE cli_kind IS NULL OR is_rootless IS NULL` returns 0
</verification>

<success_criteria>
Schema and DAL primitives ready for Plans 002–005 to consume. No regressions in existing session create/list/delete paths.
</success_criteria>

<output>
Create `.planning/phases/05-codex-cli-and-rootless-sessions/05-01-SUMMARY.md` when done
</output>
