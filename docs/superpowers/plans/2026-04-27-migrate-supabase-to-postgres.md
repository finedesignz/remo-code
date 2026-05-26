# Migrate Supabase to Local PostgreSQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Note (Phase 09, 2026-05-26):** References to `verifyChannelToken` and the `channel/` plugin in this plan are historical. Phase 09 removed the dead `/ws/channel` route and `verifyChannelToken` DAL helper. See `.planning/phases/09-retire-npm-packages/`.

**Goal:** Replace Supabase (hosted DB + Auth) with a self-hosted PostgreSQL on Coolify and a custom JWT auth system.

**Architecture:** The hub currently uses Supabase for two things: database storage (via the JS client with RLS) and authentication (Supabase Auth / JWT verification). We replace the DB client with `postgres.js` pointing at a local PG instance, add a `users` table with bcrypt-hashed passwords, issue our own JWTs with `jsonwebtoken`, and replace the Supabase Auth UI in the frontend with a custom login form. RLS is dropped entirely — all queries gain explicit `WHERE user_id = $1` clauses instead.

**Tech Stack:** Bun + Hono (hub), postgres.js (`postgres` npm package), `jsonwebtoken`, `bcryptjs`, React 19 + Vite (web), local PostgreSQL on Coolify

---

## File Map

### Hub (new/modified)
| File | Change | Purpose |
|------|--------|---------|
| `hub/src/db/postgres.ts` | **Create** | postgres.js client singleton |
| `hub/src/db/dal.ts` | **Rewrite** | All queries use postgres.js; explicit user_id filters instead of RLS |
| `hub/src/db/schema.sql` | **Create** | Full schema DDL (replaces supabase/migrations/) |
| `hub/src/auth/jwt.ts` | **Create** | Sign + verify JWTs with jsonwebtoken |
| `hub/src/auth/password.ts` | **Create** | bcrypt helpers |
| `hub/src/auth/middleware.ts` | **Rewrite** | Verify our own JWT instead of Supabase JWT |
| `hub/src/api/auth.ts` | **Create** | POST /api/auth/login, POST /api/auth/register |
| `hub/src/api/setup.ts` | **Rewrite** | Use bcrypt + postgres.js (remove Supabase admin auth) |
| `hub/src/api/profile.ts` | **Rewrite** | Query `users` table instead of `profiles` |
| `hub/src/api/api-keys.ts` | **Minor edit** | Remove supabase import, use postgres dal |
| `hub/src/api/sessions.ts` | **Minor edit** | Remove supabase import, use postgres dal |
| `hub/src/api/messages.ts` | **Minor edit** | Remove supabase import, use postgres dal |
| `hub/src/api/plugin.ts` | **Minor edit** | Remove supabase import, use postgres dal |
| `hub/src/ws/client.ts` | **Rewrite auth section** | Verify our JWT instead of Supabase JWT |
| `hub/src/ws/agent.ts` | **Minor edit** | Remove supabase import |
| `hub/src/ws/channel.ts` | **Minor edit** | Remove supabase import |
| `hub/src/config.ts` | **Rewrite** | DATABASE_URL + JWT_SECRET instead of Supabase keys |
| `hub/src/index.ts` | **Minor edit** | Remove supabase startup cleanup, keep rest |
| `hub/src/db/supabase.ts` | **Delete** | Replaced by postgres.ts |
| `hub/package.json` | **Edit** | Add postgres, jsonwebtoken, bcryptjs; remove @supabase/supabase-js |

### Web (new/modified)
| File | Change | Purpose |
|------|--------|---------|
| `web/src/lib/auth.ts` | **Create** | API calls for login/register, JWT storage in localStorage |
| `web/src/hooks/useAuth.ts` | **Rewrite** | Use custom auth (localStorage JWT) instead of Supabase |
| `web/src/components/AuthForm.tsx` | **Rewrite** | Custom login/register form, no Supabase Auth UI |
| `web/src/hooks/useWebSocket.ts` | **Minor edit** | Get JWT from localStorage instead of Supabase session |
| `web/src/lib/supabase.ts` | **Delete** | No longer needed |
| `web/package.json` | **Edit** | Remove @supabase/supabase-js, @supabase/auth-ui-react |

### Config/Infra
| File | Change | Purpose |
|------|--------|---------|
| `hub/.env.example` | **Rewrite** | DATABASE_URL, JWT_SECRET, PORT, HUB_ALLOWED_ORIGINS |
| `web/.env.example` | **Rewrite** | VITE_HUB_URL only (no Supabase keys) |
| `.env.example` | **Rewrite** | Same as hub |
| `Dockerfile` | **Minor edit** | Remove SUPABASE_* env vars from comments/examples |

---

## Task 1: PostgreSQL client + config

**Files:**
- Create: `hub/src/db/postgres.ts`
- Rewrite: `hub/src/config.ts`
- Modify: `hub/package.json`

- [ ] **Step 1: Add postgres.js and auth packages**

```bash
cd hub
bun add postgres jsonwebtoken bcryptjs
bun add -d @types/jsonwebtoken @types/bcryptjs
```

Expected: packages added to hub/package.json

- [ ] **Step 2: Rewrite config.ts**

```typescript
// hub/src/config.ts
export const config = {
  port: parseInt(process.env.PORT || "3040"),
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/remocode",
  jwtSecret: process.env.JWT_SECRET || (() => { throw new Error("JWT_SECRET required"); })(),
  allowedOrigins: (process.env.HUB_ALLOWED_ORIGINS || "http://localhost:5173").split(",").map(s => s.trim()),
};
```

- [ ] **Step 3: Create hub/src/db/postgres.ts**

```typescript
import postgres from "postgres";
import { config } from "../config.ts";

export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});
```

- [ ] **Step 4: Update hub/.env.example**

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remocode
JWT_SECRET=change-me-in-production-min-32-chars
PORT=3040
HUB_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3040
```

- [ ] **Step 5: Commit**

```bash
git add hub/package.json hub/src/db/postgres.ts hub/src/config.ts hub/.env.example
git commit -m "feat: add postgres.js client and update config for local PG"
```

---

## Task 2: Database schema (replaces supabase migrations)

**Files:**
- Create: `hub/src/db/schema.sql`

- [ ] **Step 1: Create hub/src/db/schema.sql**

```sql
-- hub/src/db/schema.sql
-- Run this once against a fresh PostgreSQL database to initialize the schema.

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  project_dir  TEXT,
  status       TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'thinking')),
  token_hash   TEXT NOT NULL,
  last_activity TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_project ON sessions(user_id, project_dir);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT 'default',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_active ON api_keys(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/db/schema.sql
git commit -m "feat: add plain PostgreSQL schema (replaces supabase migrations)"
```

---

## Task 3: JWT auth helpers

**Files:**
- Create: `hub/src/auth/jwt.ts`
- Create: `hub/src/auth/password.ts`

- [ ] **Step 1: Create hub/src/auth/jwt.ts**

```typescript
import jwt from "jsonwebtoken";
import { config } from "../config.ts";

export interface JwtPayload {
  sub: string;   // user UUID
  email: string;
  role: string;
}

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "30d" });
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}
```

- [ ] **Step 2: Create hub/src/auth/password.ts**

```typescript
import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

- [ ] **Step 3: Commit**

```bash
git add hub/src/auth/jwt.ts hub/src/auth/password.ts
git commit -m "feat: add jwt sign/verify and bcrypt password helpers"
```

---

## Task 4: Rewrite DAL (data access layer)

**Files:**
- Rewrite: `hub/src/db/dal.ts`
- Delete: `hub/src/db/supabase.ts`

- [ ] **Step 1: Rewrite hub/src/db/dal.ts**

Replace the entire file with:

```typescript
import { sql } from "./postgres.ts";

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function listSessions(userId: string) {
  return sql`
    SELECT id, name, project_dir, status, token_hash, last_activity, created_at
    FROM sessions WHERE user_id = ${userId} ORDER BY last_activity DESC NULLS LAST
  `;
}

export async function getSession(sessionId: string, userId: string) {
  const rows = await sql`
    SELECT id, name, project_dir, status, token_hash, last_activity, created_at
    FROM sessions WHERE id = ${sessionId} AND user_id = ${userId}
  `;
  return rows[0] ?? null;
}

export async function getSessionById(sessionId: string) {
  const rows = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
  return rows[0] ?? null;
}

export async function findSessionByProjectDir(userId: string, projectDir: string) {
  const rows = await sql`
    SELECT * FROM sessions
    WHERE user_id = ${userId} AND project_dir = ${projectDir}
    ORDER BY last_activity DESC NULLS LAST LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createSession(userId: string, name: string, projectDir: string | null, tokenHash: string) {
  const rows = await sql`
    INSERT INTO sessions (user_id, name, project_dir, token_hash)
    VALUES (${userId}, ${name}, ${projectDir}, ${tokenHash})
    RETURNING *
  `;
  return rows[0];
}

export async function updateSessionStatus(sessionId: string, status: string) {
  await sql`UPDATE sessions SET status = ${status}, last_activity = now() WHERE id = ${sessionId}`;
}

export async function updateSessionToken(sessionId: string, tokenHash: string) {
  await sql`UPDATE sessions SET token_hash = ${tokenHash} WHERE id = ${sessionId}`;
}

export async function deleteSession(sessionId: string, userId: string) {
  await sql`DELETE FROM sessions WHERE id = ${sessionId} AND user_id = ${userId}`;
}

export async function setOfflineStaleAgentSessions() {
  await sql`UPDATE sessions SET status = 'offline' WHERE status = 'online'`;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function listMessages(sessionId: string, userId: string) {
  return sql`
    SELECT m.id, m.session_id, m.role, m.content, m.created_at
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.session_id = ${sessionId} AND s.user_id = ${userId}
    ORDER BY m.created_at ASC
  `;
}

export async function insertMessage(sessionId: string, role: string, content: string) {
  const rows = await sql`
    INSERT INTO messages (session_id, role, content) VALUES (${sessionId}, ${role}, ${content}) RETURNING *
  `;
  return rows[0];
}

// ── API Keys ──────────────────────────────────────────────────────────────────

export async function verifyApiKey(keyHash: string) {
  const rows = await sql`
    SELECT user_id FROM api_keys WHERE key_hash = ${keyHash} AND revoked_at IS NULL LIMIT 1
  `;
  if (!rows[0]) return null;
  await sql`UPDATE api_keys SET last_used_at = now() WHERE key_hash = ${keyHash} AND revoked_at IS NULL`;
  return rows[0].user_id as string;
}

export async function listApiKeys(userId: string) {
  return sql`
    SELECT id, name, created_at, last_used_at FROM api_keys
    WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY created_at DESC
  `;
}

export async function createApiKey(userId: string, keyHash: string, name: string) {
  // revoke existing active key first
  await sql`UPDATE api_keys SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
  const rows = await sql`
    INSERT INTO api_keys (user_id, key_hash, name) VALUES (${userId}, ${keyHash}, ${name}) RETURNING *
  `;
  return rows[0];
}

export async function revokeApiKey(userId: string) {
  await sql`UPDATE api_keys SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
}

// ── Users / Profiles ──────────────────────────────────────────────────────────

export async function getUserById(id: string) {
  const rows = await sql`SELECT id, email, display_name, role, created_at, updated_at FROM users WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
  return rows[0] ?? null;
}

export async function countUsers() {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users`;
  return rows[0].count as number;
}

export async function createUser(email: string, passwordHash: string, role: string = 'user') {
  const rows = await sql`
    INSERT INTO users (email, password_hash, role) VALUES (${email}, ${passwordHash}, ${role}) RETURNING id, email, display_name, role, created_at
  `;
  return rows[0];
}

export async function updateProfile(userId: string, displayName: string) {
  const rows = await sql`
    UPDATE users SET display_name = ${displayName}, updated_at = now() WHERE id = ${userId}
    RETURNING id, email, display_name, role
  `;
  return rows[0] ?? null;
}

// ── Channel token ─────────────────────────────────────────────────────────────

export async function verifyChannelToken(sessionId: string) {
  const rows = await sql`SELECT token_hash, user_id FROM sessions WHERE id = ${sessionId}`;
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Delete hub/src/db/supabase.ts**

```bash
rm hub/src/db/supabase.ts
```

- [ ] **Step 3: Commit**

```bash
git add hub/src/db/dal.ts hub/src/db/supabase.ts
git commit -m "feat: rewrite DAL with postgres.js, remove supabase client"
```

---

## Task 5: Rewrite hub auth middleware

**Files:**
- Rewrite: `hub/src/auth/middleware.ts`

- [ ] **Step 1: Rewrite hub/src/auth/middleware.ts**

```typescript
import type { Context, Next } from "hono";
import { verifyJwt } from "./jwt.ts";

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const token = header.slice(7);
  try {
    const payload = verifyJwt(token);
    c.set("userId", payload.sub);
    c.set("userRole", payload.role);
    c.set("userEmail", payload.email);
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
  await next();
}
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/auth/middleware.ts
git commit -m "feat: replace supabase JWT verification with custom JWT middleware"
```

---

## Task 6: Rewrite WebSocket client auth

**Files:**
- Modify: `hub/src/ws/client.ts`

The client WebSocket auth currently calls `supabaseAdmin.auth.getUser(msg.token)`. Replace that section with our own JWT verification.

- [ ] **Step 1: Read the current client.ts auth section**

Open `hub/src/ws/client.ts` and find the auth block (lines ~60-85). It looks like:

```typescript
const { data: { user }, error } = await supabaseAdmin.auth.getUser(msg.token);
if (error || !user) { ws.close(4001, "Unauthorized"); return; }
conn.userId = user.id;
conn.jwt = msg.token;
conn.authenticated = true;
```

- [ ] **Step 2: Replace supabase auth with JWT verification**

Replace the import of supabaseAdmin and the auth block. Find:

```typescript
import { supabaseAdmin } from "../db/supabase.ts";
```
and any line that calls `supabaseAdmin.auth.getUser`. Replace with:

```typescript
import { verifyJwt } from "../auth/jwt.ts";
```

And replace the getUser call with:

```typescript
try {
  const payload = verifyJwt(msg.token);
  conn.userId = payload.sub;
  conn.authenticated = true;
} catch {
  ws.close(4001, "Unauthorized");
  return;
}
```

Also remove the `conn.jwt` field usage if it was only for passing to `supabaseForUser`. Remove any `supabaseForUser` imports.

- [ ] **Step 3: Commit**

```bash
git add hub/src/ws/client.ts
git commit -m "feat: replace supabase JWT auth in WS client with custom JWT"
```

---

## Task 7: Create /api/auth routes (login + register)

**Files:**
- Create: `hub/src/api/auth.ts`
- Modify: `hub/src/index.ts` (register the new routes)

- [ ] **Step 1: Create hub/src/api/auth.ts**

```typescript
import { Hono } from "hono";
import { getUserByEmail, createUser, countUsers } from "../db/dal.ts";
import { verifyPassword, hashPassword } from "../auth/password.ts";
import { signJwt } from "../auth/jwt.ts";

export const authRouter = new Hono();

authRouter.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: "Email and password required" }, 400);

  const user = await getUserByEmail(email.toLowerCase().trim());
  if (!user) return c.json({ error: "Invalid credentials" }, 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return c.json({ error: "Invalid credentials" }, 401);

  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  return c.json({ token, user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name } });
});

authRouter.post("/register", async (c) => {
  const total = await countUsers();
  // Only allow registration if no users exist yet (first user becomes admin)
  // After first user, registration is disabled — invite via setup flow
  if (total > 0) return c.json({ error: "Registration is closed" }, 403);

  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: "Email and password required" }, 400);
  if (password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

  const hash = await hashPassword(password);
  const user = await createUser(email.toLowerCase().trim(), hash, "admin");
  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  return c.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});
```

- [ ] **Step 2: Register auth routes in hub/src/index.ts**

Find where other API routes are registered. Add:

```typescript
import { authRouter } from "./api/auth.ts";
// ... inside the app route registration:
app.route("/api/auth", authRouter);
```

- [ ] **Step 3: Commit**

```bash
git add hub/src/api/auth.ts hub/src/index.ts
git commit -m "feat: add /api/auth/login and /api/auth/register endpoints"
```

---

## Task 8: Rewrite setup, profile, and remaining API files

**Files:**
- Rewrite: `hub/src/api/setup.ts`
- Rewrite: `hub/src/api/profile.ts`
- Modify: `hub/src/api/api-keys.ts`
- Modify: `hub/src/api/sessions.ts`
- Modify: `hub/src/api/messages.ts`
- Modify: `hub/src/api/plugin.ts`

- [ ] **Step 1: Rewrite hub/src/api/setup.ts**

```typescript
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { countUsers, createUser } from "../db/dal.ts";
import { hashPassword } from "../auth/password.ts";

export const setupRouter = new Hono();

let setupInProgress = false;

const setupLimiter = rateLimiter({ windowMs: 60_000, limit: 5, keyGenerator: (c) => c.req.header("x-forwarded-for") || "unknown" });

setupRouter.get("/status", setupLimiter, async (c) => {
  const count = await countUsers();
  return c.json({ needsSetup: count === 0 });
});

setupRouter.post("/create-admin", setupLimiter, async (c) => {
  if (setupInProgress) return c.json({ error: "Setup already in progress" }, 409);
  setupInProgress = true;
  try {
    const count = await countUsers();
    if (count > 0) return c.json({ error: "Admin already exists" }, 409);

    const { email, password } = await c.req.json<{ email: string; password: string }>();
    if (!email || !password) return c.json({ error: "Email and password required" }, 400);
    if (password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

    const hash = await hashPassword(password);
    const user = await createUser(email.toLowerCase().trim(), hash, "admin");
    return c.json({ success: true, user: { id: user.id, email: user.email, role: user.role } });
  } finally {
    setupInProgress = false;
  }
});
```

- [ ] **Step 2: Rewrite hub/src/api/profile.ts**

```typescript
import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware.ts";
import { getUserById, updateProfile } from "../db/dal.ts";

export const profileRouter = new Hono();
profileRouter.use("/*", authMiddleware);

profileRouter.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const user = await getUserById(userId);
  if (!user) return c.json({ error: "Not found" }, 404);
  return c.json(user);
});

profileRouter.patch("/", async (c) => {
  const userId = c.get("userId") as string;
  const { display_name } = await c.req.json<{ display_name: string }>();
  const updated = await updateProfile(userId, display_name);
  return c.json(updated);
});
```

- [ ] **Step 3: Remove supabase imports from api-keys.ts, sessions.ts, messages.ts, plugin.ts**

Each of these files currently imports from `../db/supabase.ts` or uses `supabaseForUser`. Remove those imports. They already call `dal.ts` functions — verify they import from `../db/dal.ts` and update imports if needed. The dal functions now take `userId` directly (no supabase client needed).

For `hub/src/api/api-keys.ts`, replace any `supabase.from(...)` calls with the dal functions `listApiKeys`, `createApiKey`, `revokeApiKey`.

For `hub/src/api/sessions.ts`, replace with `listSessions`, `getSession`, `createSession`, `deleteSession` from dal.

For `hub/src/api/messages.ts`, replace with `listMessages` from dal.

For `hub/src/api/plugin.ts`, replace with `createSession`, `updateSessionToken` from dal.

- [ ] **Step 4: Commit**

```bash
git add hub/src/api/setup.ts hub/src/api/profile.ts hub/src/api/api-keys.ts hub/src/api/sessions.ts hub/src/api/messages.ts hub/src/api/plugin.ts
git commit -m "feat: remove supabase from all API handlers, use postgres dal"
```

---

## Task 9: Remove supabase from ws/agent.ts and ws/channel.ts

**Files:**
- Modify: `hub/src/ws/agent.ts`
- Modify: `hub/src/ws/channel.ts`

- [ ] **Step 1: Update hub/src/ws/agent.ts**

The agent already calls `verifyApiKey(keyHash)` from dal. Remove any import of `supabaseAdmin` or `supabaseForUser`. The `verifyApiKey` function now returns `userId: string | null` (previously it returned a row from Supabase). Ensure the auth block uses:

```typescript
const userId = await verifyApiKey(keyHash);
if (!userId) { ws.close(4001, "Unauthorized"); return; }
conn.userId = userId;
```

- [ ] **Step 2: Update hub/src/ws/channel.ts**

The channel already calls `verifyChannelToken(sessionId)`. Remove any supabase imports. The `verifyChannelToken` now returns `{ token_hash, user_id } | null`. Ensure the auth block uses:

```typescript
const session = await verifyChannelToken(msg.session_id);
if (!session) { ws.close(4001, "Not found"); return; }
// timing-safe compare of msg.token vs session.token_hash
```

- [ ] **Step 3: Update hub/src/index.ts startup cleanup**

Find the startup section that calls supabase to set sessions offline. Replace with:

```typescript
import { setOfflineStaleAgentSessions } from "./db/dal.ts";
// in startup:
await setOfflineStaleAgentSessions();
```

Remove the `supabaseAdmin` import from index.ts.

- [ ] **Step 4: Commit**

```bash
git add hub/src/ws/agent.ts hub/src/ws/channel.ts hub/src/index.ts
git commit -m "feat: remove last supabase references from ws handlers and startup"
```

---

## Task 10: Remove @supabase/supabase-js from hub

**Files:**
- Modify: `hub/package.json`

- [ ] **Step 1: Remove the supabase package**

```bash
cd hub
bun remove @supabase/supabase-js
```

- [ ] **Step 2: Verify no remaining supabase imports**

```bash
grep -r "supabase" hub/src/ --include="*.ts"
```

Expected: no output (or only comments)

- [ ] **Step 3: Commit**

```bash
git add hub/package.json hub/bun.lockb
git commit -m "chore: remove @supabase/supabase-js from hub dependencies"
```

---

## Task 11: Rewrite web auth (frontend)

**Files:**
- Create: `web/src/lib/auth.ts`
- Rewrite: `web/src/hooks/useAuth.ts`
- Rewrite: `web/src/components/AuthForm.tsx`
- Modify: `web/src/hooks/useWebSocket.ts`
- Delete: `web/src/lib/supabase.ts`

- [ ] **Step 1: Create web/src/lib/auth.ts**

```typescript
const HUB_URL = import.meta.env.VITE_HUB_URL || "";

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  display_name?: string;
}

export async function apiLogin(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${HUB_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Login failed" }));
    throw new Error(err.error || "Login failed");
  }
  return res.json();
}

export async function apiRegister(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${HUB_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Registration failed" }));
    throw new Error(err.error || "Registration failed");
  }
  return res.json();
}

export function getStoredToken(): string | null {
  return localStorage.getItem("remo_token");
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem("remo_user");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function storeAuth(token: string, user: AuthUser): void {
  localStorage.setItem("remo_token", token);
  localStorage.setItem("remo_user", JSON.stringify(user));
}

export function clearAuth(): void {
  localStorage.removeItem("remo_token");
  localStorage.removeItem("remo_user");
}
```

- [ ] **Step 2: Rewrite web/src/hooks/useAuth.ts**

```typescript
import { useState, useEffect, useCallback } from "react";
import { getStoredToken, getStoredUser, storeAuth, clearAuth, type AuthUser } from "../lib/auth.ts";

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ user: null, token: null, loading: true });

  useEffect(() => {
    const token = getStoredToken();
    const user = getStoredUser();
    setState({ user, token, loading: false });
  }, []);

  const signIn = useCallback((token: string, user: AuthUser) => {
    storeAuth(token, user);
    setState({ user, token, loading: false });
  }, []);

  const signOut = useCallback(() => {
    clearAuth();
    setState({ user: null, token: null, loading: false });
  }, []);

  return { ...state, signIn, signOut };
}
```

- [ ] **Step 3: Rewrite web/src/components/AuthForm.tsx**

```tsx
import { useState } from "react";
import { apiLogin, apiRegister } from "../lib/auth.ts";
import type { AuthUser } from "../lib/auth.ts";

interface Props {
  onAuth: (token: string, user: AuthUser) => void;
}

export function AuthForm({ onAuth }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const fn = mode === "login" ? apiLogin : apiRegister;
      const { token, user } = await fn(email, password);
      onAuth(token, user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-form">
      <form onSubmit={handleSubmit}>
        <h2>{mode === "login" ? "Sign in" : "Create account"}</h2>
        {error && <p className="auth-error">{error}</p>}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
        <button type="submit" disabled={loading}>
          {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button className="auth-toggle" onClick={() => { setMode(m => m === "login" ? "register" : "login"); setError(null); }}>
        {mode === "login" ? "Need an account?" : "Already have an account?"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Update web/src/hooks/useWebSocket.ts**

Replace the section that gets the token from Supabase:

Find:
```typescript
import { supabase } from "../lib/supabase.ts";
// and
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;
```

Replace with:
```typescript
import { getStoredToken } from "../lib/auth.ts";
// and
const token = getStoredToken();
```

- [ ] **Step 5: Delete web/src/lib/supabase.ts**

```bash
rm web/src/lib/supabase.ts
```

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/auth.ts web/src/hooks/useAuth.ts web/src/components/AuthForm.tsx web/src/hooks/useWebSocket.ts web/src/lib/supabase.ts
git commit -m "feat: replace supabase auth UI with custom JWT login form"
```

---

## Task 12: Remove Supabase packages from web, update env examples

**Files:**
- Modify: `web/package.json`
- Rewrite: `web/.env.example`
- Rewrite: `.env.example` (root)

- [ ] **Step 1: Remove supabase packages from web**

```bash
cd web
bun remove @supabase/supabase-js @supabase/auth-ui-react @supabase/auth-ui-shared
```

- [ ] **Step 2: Verify no remaining supabase imports in web**

```bash
grep -r "supabase" web/src/ --include="*.ts" --include="*.tsx"
```

Expected: no output

- [ ] **Step 3: Rewrite web/.env.example**

```
VITE_HUB_URL=http://localhost:3040
```

- [ ] **Step 4: Rewrite root .env.example**

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remocode
JWT_SECRET=change-me-in-production-min-32-chars
PORT=3040
HUB_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3040
```

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/bun.lockb web/.env.example .env.example
git commit -m "chore: remove @supabase/* from web, update env examples"
```

---

## Task 13: Update CLAUDE.md and deployment docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `Dockerfile` (if needed)

- [ ] **Step 1: Update CLAUDE.md environment variables section**

Find the `## Environment Variables` section. Replace:

```markdown
**hub/.env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT` (3040), `HUB_ALLOWED_ORIGINS`

**web/.env**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_HUB_URL`
```

With:

```markdown
**hub/.env**: `DATABASE_URL` (PostgreSQL connection string), `JWT_SECRET` (min 32 chars), `PORT` (3040), `HUB_ALLOWED_ORIGINS`

**web/.env**: `VITE_HUB_URL`
```

Also update the database section to remove Supabase references:

```markdown
## Database

Uses **PostgreSQL** (self-hosted). Schema in `hub/src/db/schema.sql` — run once on a fresh database.

Tables: `users` (email + bcrypt password, role), `sessions` (Claude Code sessions), `messages` (chat history), `api_keys` (agent authentication). All queries are scoped by `user_id` with explicit WHERE clauses.
```

- [ ] **Step 2: Check Dockerfile for Supabase references**

```bash
grep -i supabase Dockerfile
```

If any `ARG SUPABASE_*` or `ENV SUPABASE_*` lines exist, remove them and add `JWT_SECRET` and `DATABASE_URL` instead.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md Dockerfile
git commit -m "docs: update CLAUDE.md and Dockerfile for postgres migration"
```

---

## Final Verification

After all tasks complete:

```bash
# Verify no supabase imports remain anywhere
grep -r "supabase" hub/src/ web/src/ --include="*.ts" --include="*.tsx" -l

# Run type check
cd hub && bun run typecheck || bun tsc --noEmit
cd ../web && bun run typecheck || bun tsc --noEmit

# Start hub against a local postgres to smoke-test
# (requires DATABASE_URL and JWT_SECRET in hub/.env)
bun run dev:hub
```
