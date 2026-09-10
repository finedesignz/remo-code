---
phase: 05-codex-cli-and-rootless-sessions
plan: 01
subsystem: hub/db
tags: [schema, dal, sessions, codex, rootless]
requires: []
provides:
  - sessions.cli_kind column
  - sessions.is_rootless column
  - sessions.hostname column
  - idx_sessions_rootless_unique partial unique index
  - findOrCreateRootlessSession DAL
  - extended createSession signature
affects:
  - hub/src/db/schema.sql
  - hub/src/db/dal.ts
key-files:
  created: []
  modified:
    - hub/src/db/schema.sql
    - hub/src/db/dal.ts
decisions:
  - "DO $$ block on a single line so the migrate.ts splitter (;\\s*\\n) doesn't break the body"
  - "CHECK constraint added via information_schema guard for idempotency on re-runs"
  - "findOrCreateRootlessSession uses SELECT-then-INSERT ON CONFLICT DO NOTHING + re-SELECT to handle concurrent agent auth races"
  - "createSession kept positional with new args appended as optional → zero call-site churn"
metrics:
  duration_minutes: 5
  tasks_completed: 2
  files_modified: 2
---

# Phase 5 Plan 1: Schema + DAL primitives for CLI kind & rootless sessions Summary

One-liner: Added `cli_kind` ('claude'|'codex'), `is_rootless` (bool), `hostname` (text) columns to `sessions` with a partial unique index enforcing one rootless row per (user, host, cli_kind), plus a `findOrCreateRootlessSession` DAL helper.

## What Shipped

### Task 1 — Schema (commit f039345)
- `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_kind TEXT NOT NULL DEFAULT 'claude'`
- CHECK constraint `cli_kind IN ('claude','codex')` added via single-line `DO $$` guard against `information_schema.check_constraints` so re-runs are idempotent.
- `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_rootless BOOLEAN NOT NULL DEFAULT false`
- `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS hostname TEXT` (nullable)
- `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_rootless_unique ON sessions(user_id, hostname, cli_kind) WHERE is_rootless = true AND deleted_at IS NULL`
- Existing rows backfill to `cli_kind='claude'`, `is_rootless=false`, `hostname=NULL` automatically via the column defaults.

### Task 2 — DAL (commit c47bb7a)
- `createSession(userId, name, projectDir, tokenHash, cliKind?, isRootless?, hostname?)` — new optional args, defaults preserve legacy behavior. Existing call in `hub/src/api/sessions.ts:78` unchanged.
- `findOrCreateRootlessSession(userId, hostname, cliKind, tokenHashIfCreating, nameIfCreating)` — SELECT first, then INSERT with `ON CONFLICT DO NOTHING` against the partial unique index, then re-SELECT. Returns `{ ...row, created }`. Idempotent under concurrent inserts.
- `listSessions` projection extended with `cli_kind, is_rootless, hostname` so the API surfaces them.

## Deviations from Plan
None — plan executed as written.

## Verification

- `bunx tsc --noEmit --skipLibCheck hub/src/db/dal.ts` → clean.
- `hub/src/api/sessions.ts` tsc errors observed are **pre-existing** Hono context typing issues unrelated to this plan (no `createSession` overload errors, no `findOrCreateRootlessSession` errors). `git blame` confirms those lines pre-date this commit.
- Live migration not run per execution constraint ("no `psql` / migrations against any live DB — schema.sql edits only"). The next hub boot will apply via `hub/src/db/migrate.ts`.

## Acceptance Criteria
- [x] sessions table has cli_kind column constrained to ('claude','codex'), default 'claude'
- [x] sessions table has is_rootless boolean column, default false
- [x] sessions table has hostname column (nullable)
- [x] Partial unique index enforces one rootless per (user_id, hostname, cli_kind)
- [x] Existing rows backfill cli_kind='claude', is_rootless=false (column defaults)
- [x] DAL exposes createSession(cli_kind, is_rootless, hostname) and findOrCreateRootlessSession

## Self-Check: PASSED
- FOUND: hub/src/db/schema.sql (modified)
- FOUND: hub/src/db/dal.ts (modified)
- FOUND: commit f039345 (schema)
- FOUND: commit c47bb7a (DAL)
