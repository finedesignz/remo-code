---
plan_id: 03-PLAN-001-schema-and-api
wave: 1
depends_on: []
files_modified:
  - hub/src/db/schema.sql
  - hub/src/db/chat-tabs-dal.ts
  - hub/src/api/chat-tabs.ts
  - hub/src/api/sessions.ts
  - hub/src/index.ts
  - hub/test/chat-tabs.test.ts
autonomous: true
requirements: [R01, R02, R08, R11]
---

# Plan 03-001 — Schema + API for chat tabs

<tasks>

<task id="T1">
<action>Add `chat_tabs` table to `hub/src/db/schema.sql` via `CREATE TABLE IF NOT EXISTS`. Columns: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64)`, `layout TEXT NOT NULL DEFAULT 'auto-fit' CHECK (layout IN ('3x3','4x3','auto-fit'))`, `position INTEGER NOT NULL DEFAULT 0`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Index: `CREATE INDEX IF NOT EXISTS idx_chat_tabs_user_position ON chat_tabs(user_id, position)`.</action>
<read_first>
- hub/src/db/schema.sql (full file — match the idempotent ADD COLUMN / CREATE TABLE IF NOT EXISTS style used everywhere else)
- .planning/codebase/CONVENTIONS.md (Database Access section)
</read_first>
<acceptance_criteria>
- `bun run dev:hub` boots cleanly against an existing DB
- Re-running schema.sql is a no-op (no errors, no duplicate-table errors)
- `\d chat_tabs` in psql shows the exact columns + cascade FK
</acceptance_criteria>
</task>

<task id="T2">
<action>Add `chat_tab_sessions` table to `hub/src/db/schema.sql`. Columns: `tab_id UUID NOT NULL REFERENCES chat_tabs(id) ON DELETE CASCADE`, `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`, `position INTEGER NOT NULL DEFAULT 0`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, composite PK `(tab_id, session_id)`. Indexes: `CREATE INDEX IF NOT EXISTS idx_chat_tab_sessions_tab_position ON chat_tab_sessions(tab_id, position)`, `CREATE INDEX IF NOT EXISTS idx_chat_tab_sessions_session ON chat_tab_sessions(session_id)`.</action>
<read_first>
- hub/src/db/schema.sql (composite PK pattern, if any)
</read_first>
<acceptance_criteria>
- Composite PK exists and is `(tab_id, session_id)`
- Both FKs are `ON DELETE CASCADE` — verified by `\d chat_tab_sessions`
- Deleting a tab row cascades and removes all `chat_tab_sessions` for that tab
- Deleting a session row cascades and removes the tab membership rows
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `hub/src/db/chat-tabs-dal.ts` with named exports: `listTabsForUser(userId): Promise<Tab[]>`, `getTab(tabId, userId): Promise<TabWithSessions | null>`, `createTab(userId, { name, layout }): Promise<Tab>`, `updateTab(tabId, userId, fields: { name?, layout?, position? }): Promise<Tab>`, `deleteTab(tabId, userId): Promise<void>`, `setTabPositions(userId, orderedIds: string[]): Promise<void>` (transaction — rewrites positions to gap-free), `listSessionsForTab(tabId, userId): Promise<SessionRef[]>`, `addSessionToTab(tabId, userId, sessionId): Promise<void>`, `removeSessionFromTab(tabId, userId, sessionId): Promise<void>`, `setTabSessionPositions(tabId, userId, orderedSessionIds: string[]): Promise<void>` (transaction). Every query that touches `chat_tabs` or `chat_tab_sessions` MUST include an explicit `WHERE user_id = $1` (or join through `chat_tabs` to derive it) — no unscoped reads.</action>
<read_first>
- hub/src/db/dal.ts (whole file — match the connection import, the named-export pattern, the `WHERE user_id = $1` discipline)
- hub/src/db/scheduled-tasks-dal.ts (mirror its file layout: types at top, queries below)
</read_first>
<acceptance_criteria>
- `grep -nE "FROM (chat_tabs|chat_tab_sessions)" hub/src/db/chat-tabs-dal.ts | grep -v "user_id" ` returns nothing (every query is user-scoped, either directly or via join)
- `setTabPositions` and `setTabSessionPositions` run inside a transaction (BEGIN/COMMIT or `db.begin(...)`)
- All functions take `userId` as the first or second argument; none read globally
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `hub/src/api/chat-tabs.ts` exporting `chatTabsRouter = new Hono()`. Endpoints (all behind the existing JWT `authMiddleware`, `userId` read from context): `GET /api/chat-tabs` → `Tab[]` (with embedded `sessions: SessionRef[]`), `POST /api/chat-tabs` (Zod-validated body `{ name, layout? }`) → `Tab`, `PATCH /api/chat-tabs/:id` (body `{ name?, layout?, position? }`) → `Tab`, `DELETE /api/chat-tabs/:id` → `204`, `POST /api/chat-tabs/:id/sessions` (body `{ session_id }`) → `204`, `DELETE /api/chat-tabs/:id/sessions/:sid` → `204`, `PATCH /api/chat-tabs/:id/sessions` (body `{ ordered_session_ids: string[] }`, bulk reorder) → `204`, `PATCH /api/chat-tabs/order` (body `{ ordered_tab_ids: string[] }`, bulk reorder tabs) → `204`. Mount in `hub/src/index.ts` AFTER the JWT auth middleware block: `app.route('/api/chat-tabs', chatTabsRouter)`.</action>
<read_first>
- hub/src/api/sessions.ts (the canonical CRUD router pattern in this repo)
- hub/src/api/scheduled-tasks.ts (Zod-validated request bodies)
- hub/src/index.ts (mount-point ordering — find where other authed routes are mounted)
</read_first>
<acceptance_criteria>
- All 8 routes return JSON or 204; errors return `{ error: string }` with appropriate 4xx status
- A request with a JWT for user A asking to delete user B's tab returns 404 (not 403 — do not leak existence)
- Body validation uses Zod at the route boundary; invalid bodies return 400 with the Zod error message
</acceptance_criteria>
</task>

<task id="T5">
<action>Add `GET /api/sessions/messages` to `hub/src/api/sessions.ts`. Query params: `ids` (comma-separated session_ids) and `limit` (default 30, max 100). Validate `ids` length ≤ 12 — return 400 `{ error: 'too_many_sessions', max: 12 }` if exceeded. For each session_id in `ids`, verify ownership by `user_id` (skip silently any that are not owned) and fetch the last `limit` messages newest-last. Response: `{ [sessionId]: Message[] }`. Add a DAL helper `getMessagesForSessions(userId, sessionIds: string[], limit: number)` to `hub/src/db/dal.ts` that runs in a single query using `WHERE session_id = ANY($2) AND session_id IN (SELECT id FROM sessions WHERE user_id = $1)`.</action>
<read_first>
- hub/src/api/sessions.ts (existing single-session messages endpoint to mirror)
- hub/src/db/dal.ts (`getMessagesForSession` if it exists — match its column order)
</read_first>
<acceptance_criteria>
- Request with `ids=` of length 13 returns 400 with `error: 'too_many_sessions'`
- Request from user A with a mix of A's session and B's session returns only A's messages (B's silently dropped)
- One SQL query touches `messages` (not N) — verified by reading the DAL function
- Response shape is `{ [sid]: Message[] }` with messages sorted oldest-first within each array
</acceptance_criteria>
</task>

<task id="T6">
<action>Write `hub/test/chat-tabs.test.ts` (Bun test). Cases: create-tab → list returns it; add 3 sessions → list returns them in insert order; reorder via `PATCH /:id/sessions` → list returns new order; tab delete cascades and removes `chat_tab_sessions` rows; user A cannot read/modify user B's tab (404); `GET /api/sessions/messages?ids=...&limit=30` returns the right shape and respects the 12-id cap and the ownership filter. Use the existing test scaffolding from `hub/test/scheduler.test.ts` and `hub/test/scheduled-tasks.e2e.test.ts` (env `REMO_E2E_DB_URL`; skip if unset).</action>
<read_first>
- hub/test/scheduled-tasks.e2e.test.ts (env-gated skip pattern, DB fixture pattern)
- hub/test/scheduler.test.ts (unit test format, assertion style)
</read_first>
<acceptance_criteria>
- `bun test hub/test/chat-tabs.test.ts` is green with `REMO_E2E_DB_URL` set; skips cleanly without it
- Each case has a clear `test(...)` name; assertions use `expect(...).toBe(...)` style
- Cascade-delete test asserts row count drops to 0 after parent delete
</acceptance_criteria>
</task>

</tasks>

must_haves:
- Two new tables exist with the exact cascade FKs (`users → chat_tabs → chat_tab_sessions ← sessions`, all CASCADE)
- Every DAL query touching the new tables is user-scoped; no query trusts the caller for `user_id`
- `GET /api/sessions/messages` exists, caps at 12 ids, and returns `{ [sid]: Message[] }` from a single SQL query
- All API routes are mounted behind the JWT auth middleware
- The Bun test file passes against a real Postgres when `REMO_E2E_DB_URL` is set; the schema migration is the only DB-state precondition
