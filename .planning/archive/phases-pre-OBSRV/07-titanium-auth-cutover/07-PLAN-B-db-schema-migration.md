# 07-PLAN-B: DB schema migration (additive only)

**Stage:** B
**Wave:** 1 (parallelizable with PLAN-A)
**Mode:** standard
**TDD:** yes
**Requirements:** R-AUTH-02, R-AUTH-08

<read_first>
- `07-CONTEXT.md` `<specifics>` (new columns + tables) and `<decisions>` "Email-collision policy" + "auth_sessions" rename note
- `07-RESEARCH.md` §1.5
- `hub/src/db/schema.sql` (entire file — note existing migration style, the `sessions` table that already exists for Claude convos)
- `hub/src/db/migrate.ts` — bootstrap runner
- `hub/src/db/postgres.ts` — `sql` template literal pattern
- `hub/src/db/dal.ts` — existing user helper signatures
</read_first>

<tasks>

### B.1 Append migration block to `hub/src/db/schema.sql`
- Idempotent (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- Block ordering: alter `users`, create `auth_sessions`, create `auth_events`.
- New `users` columns:
  ```sql
  ALTER TABLE users ADD COLUMN IF NOT EXISTS titanium_subject TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_titanium_subject ON users(titanium_subject) WHERE titanium_subject IS NOT NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS titanium_email TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_titanium_sync_at TIMESTAMPTZ;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS license_status TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS license_id TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS license_checked_at TIMESTAMPTZ;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS titanium_link_status TEXT CHECK (titanium_link_status IN ('linked','pending_verify','mismatch') OR titanium_link_status IS NULL);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS candidate_subject TEXT;
  ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
  ```
- New tables:
  ```sql
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id          TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    ip          TEXT,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS auth_events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type  TEXT NOT NULL,
    ip          TEXT,
    user_agent  TEXT,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata    JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_auth_events_user_ts ON auth_events(user_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_auth_events_type_ts ON auth_events(event_type, ts DESC);
  ```
<acceptance_criteria>
Running `bun run hub/src/db/migrate.ts` on a fresh DB succeeds. Running it twice in a row succeeds (idempotency). `\d users` shows all 8 new columns + `password_hash` nullable. `\d auth_sessions` + `\d auth_events` show expected shape.
</acceptance_criteria>

### B.2 Extend `hub/src/db/dal.ts` with new helpers
- Add (typed, parameterized via `sql` template):
  - `getUserByTitaniumSubject(subject: string): Promise<User | null>`
  - `linkTitaniumSubject(userId: string, subject: string, email: string): Promise<void>` — sets `titanium_subject`, `titanium_email`, `last_titanium_sync_at = now()`, `titanium_link_status = 'linked'`
  - `setPendingVerify(userId: string, candidateSubject: string, candidateEmail: string): Promise<void>`
  - `promoteCandidateSubject(userId: string): Promise<void>` — only if `titanium_link_status = 'pending_verify'`
  - `updateLicenseStatus(userId: string, status: string, licenseId: string | null): Promise<void>` — also sets `license_checked_at = now()`
  - `updateUserEmail(userId: string, newEmail: string): Promise<{ updated: boolean; conflict: boolean }>` — handles UNIQUE collision
  - `createAuthSession(opts: { userId; ip?; userAgent?; ttlSeconds }): Promise<{ id: string; expiresAt: Date }>` — uses crypto-random ID
  - `getAuthSessionById(id: string): Promise<AuthSession | null>` — returns null if expired
  - `touchAuthSession(id: string): Promise<void>` — `last_used_at = now()` (no expires bump unless idle policy says so — see PLAN-C)
  - `deleteAuthSession(id: string): Promise<void>`
  - `purgeExpiredAuthSessions(): Promise<number>` — for cron
  - `recordAuthEvent(opts: { userId?: string; eventType: string; ip?; userAgent?; metadata? }): Promise<void>`
- All functions parameterized — no string interpolation into SQL.
<acceptance_criteria>
Each helper has a unit test in `hub/test/db-dal-auth.test.ts` covering the happy path + a key edge case (e.g. `getAuthSessionById` returns null when `expires_at < now()`). Tests gated on `REMO_E2E_DB_URL` like existing e2e tests. All pass against a fresh DB.
</acceptance_criteria>

### B.3 Mapping-conflict logging
- `link_mismatch` events go into `auth_events` with `metadata = { candidate_subject, attempted_subject }`. No separate `mapping_conflicts` table needed — CONTEXT.md notes this fold-in.
- Document the convention in `hub/src/db/dal.ts` header comment.
<acceptance_criteria>
Searching `auth_events WHERE event_type='link_mismatch'` returns the expected rows after a simulated callback collision (tested via the dal unit test).
</acceptance_criteria>

</tasks>

**Outputs:** schema migration block in `schema.sql`, 11 new DAL functions, dal test file. NO behavior change to running app (new columns/tables unused).

**Verification:** `bun run hub/src/db/migrate.ts` idempotent on prod-shaped DB; new DAL tests green.
