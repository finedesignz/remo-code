# Phase 07: Titanium Auth Cutover — Research

**Produced:** 2026-05-25
**Inputs:** `07-CONTEXT.md` (LOCKED), `~/.claude/plans/cheeky-watching-crystal.md` (architect template), repo source under `hub/`, `web/`, project rules.

---

## 1. Current auth state in remo-code (the thing being replaced)

### 1.1 Login + token issuance
- `hub/src/api/auth.ts` — single file. `POST /login` (bcrypt verify + HS256 JWT issue), `POST /register` (first-user-only registration). 34 LOC total.
- `hub/src/auth/password.ts` — bcrypt wrappers (`hashPassword`, `verifyPassword`).
- `hub/src/auth/jwt.ts` — `signJwt` / `verifyJwt`, HS256, `JWT_SECRET` from `config`, 30d default TTL. **22 LOC total** — small surface to swap.
- `JwtPayload` shape: `{ sub: userId, email, role }`. Same shape will be preserved server-side for in-process context; only the wire format changes.

### 1.2 REST middleware
- `hub/src/auth/middleware.ts` — single function `authMiddleware`. Reads `Authorization: Bearer <jwt>`, verifies, sets `c.set('userId' | 'userRole' | 'userEmail')`. Returns 401 on failure.
- `hub/src/auth/api-key-middleware.ts` — separate path for `/ws/agent` style traffic. **NOT touched this phase.**
- Mount order in `hub/src/index.ts` (presumed): security middleware → `/health` → `/api/sentry/*/envelope/` (PUBLIC) → JWT catch-all (`authMiddleware`) → rest of `/api/*`. The public sentry intake mount is OUTSIDE the catch-all and must stay that way.

### 1.3 WS auth (`/ws/client`)
- `hub/src/ws/client.ts` — auth handler accepts `{ type: 'auth', token }`. Verifies via `verifyJwt`. Same `JwtPayload`. 5s auth timeout, per-IP cap 20, per-conn rate limits.
- `hub/src/ws/agent.ts` — separate API-key auth path. NOT touched.
- `hub/src/ws/supervisor.ts` (via `supervisor-registry.ts`) — separate auth. NOT touched.

### 1.4 Web client
- `web/src/lib/hubFetch.ts` — wraps `fetch`, attaches `Authorization: Bearer <token>` where `token = localStorage.session`.
- `web/src/main.tsx` / `App.tsx` — bootstraps login state from `localStorage.session`.
- Login form lives in a `LoginPage.tsx` component (under `web/src/components/`).

### 1.5 DB schema (relevant slice)
```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,            -- becomes NULL in Phase 07
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TIMESTAMPTZ DEFAULT now()
);
-- + ALTER TABLE additions over time:
--   display_name, avatar_url, system_prompt, daily_cost_cap_usd,
--   web_push_enabled, timezone, claude_global_md, codex_agents_md,
--   codex_config_toml (Phase 05 instruction blobs)
```

The existing `sessions` table is for **Claude Code conversations** (`session_id TEXT`, `project_dir`, `agent_info`, `deleted_at` etc.) — NOT browser auth sessions. **Phase 07's new server-side opaque session table MUST be named `auth_sessions`** to avoid catastrophic collision. CONTEXT.md updated.

### 1.6 Existing infra to reuse
- `hub/src/middleware/rate-limit.ts` — already present. **Audit needed:** confirm it supports IP keying + per-user keying + multi-window (3/min/IP + 5/hr/email needs two windows per route). If it only does single-window, planner extends; do not replace.
- `hub/src/lib/crypto.ts` — has SHA-256 + (likely) HMAC helpers. Reuse for CSRF compare + magic-link signing fallback.
- `hub/src/db/migrate.ts` — wraps `schema.sql`. Idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS` is the established pattern. Phase 07 migration appends to `schema.sql`.
- emails4agents env vars already documented in `hub/src/config.ts` (presumed via grep `E4A_`).

### 1.7 Areas with NO existing infra (must be added this phase)
- No security-headers middleware found in `hub/src/middleware/`. Add `hub/src/middleware/security-headers.ts`.
- No CSRF infra. Add `hub/src/csrf.ts`.
- No opaque-session infra (the existing `sessions` table is for Claude convos, not auth). Add `hub/src/session.ts` + `auth_sessions` table.
- No Redis client in hub today (greps for `ioredis` / `redis` come up empty in non-Phase07 files). Add `ioredis`.
- No JWKS verifier. Add `jose`.

---

## 2. Titanium Licensing — actual shape (Keygen CE-based, NOT OIDC)

### 2.1 What it IS
- Keygen CE under the hood. Identity = Keygen User (email-keyed, UUID-stable).
- Licenses = Ed25519-signed Keygen License JWTs, validated via JWKS at `/v1/accounts/:id/.well-known/jwks.json`.
- Revocation: Redis blocklist + license `expiry` / `suspended` state.
- Customer-facing auth in Titanium's own `license-portal`: **magic-link** (15-min HS256 JWT signed with per-app secret → 7d `lp_session` httpOnly cookie). Reference impl: `services/license-portal/src/lib/auth.ts` in the titanium-licensing repo.

### 2.2 What it ISN'T
- NOT an OIDC provider — no `/oauth/authorize`, no `/oauth/token`, no identity JWT separate from license JWT.
- NO refresh tokens.
- NO Python SDK (`@titanium/license-client` is TS-only — bonus for remo-code, the TS-to-TS port is trivial).

### 2.3 What this means for remo-code's flow
- "Sign in with Titanium" = local magic-link flow in remo-code's hub, mirroring `services/license-portal/src/lib/auth.ts`. NOT a redirect to license-portal.
- Hub-issued magic-link JWT (HS256 with `MAGIC_LINK_SECRET`, 15-min TTL, single-use `jti`) sent via emails4agents. On callback, hub exchanges email for Keygen User via admin API (`TITANIUM_ADMIN_TOKEN`), applies email-collision policy, creates `auth_sessions` row.
- Separately, hub fetches the user's license JWT via `POST /v1/accounts/:id/licenses/actions/validate-key` (using either a license-key the user owns OR an admin-token query for licenses associated with the Keygen User) to cache `license_status` for the gate middleware.

### 2.4 JWKS endpoint
- Pattern: `${TITANIUM_KEYGEN_API_URL}/v1/accounts/${TITANIUM_ACCOUNT_ID}/.well-known/jwks.json`.
- Returns standard JWKS with `kid` per key. EdDSA (Ed25519) keys, `crv: Ed25519`, `kty: OKP`.
- `jose`'s `createRemoteJWKSet(URL)` does the right thing: in-memory cache, single-flight fetch, refresh on `kid` miss.

### 2.5 Webhook availability
- **Open question.** Architect template flagged the same uncertainty for claude-code-cli-gateway: `license.changed` webhook may not be live yet. Fallback is the 5-min in-process TTL cache + the real-time Redis blocklist. Planner ships the optional `POST /webhooks/titanium/license-changed` receiver with HMAC verification scaffolded; if Titanium doesn't expose it yet, the route stays dormant.

---

## 3. Library choices

### 3.1 `jose`
- Zero deps. Native EdDSA + JWKS support. Same lib already used in Keygen ecosystem.
- API: `createRemoteJWKSet(url)` + `jwtVerify(token, jwks, { issuer, audience, algorithms: ['EdDSA'], clockTolerance: 30 })`. Throws on any validation failure — caller wraps in try/catch.
- **Confirmed not in `package.json`.** Adding it is a 1-line change.

### 3.2 `ioredis`
- Battle-tested. Pub/sub support (handy if Titanium pushes blocklist updates as Redis pub/sub events, common Keygen pattern).
- Single client per process. Re-used for: blocklist check, magic-link `jti` reservation, license cache, rate-limit buckets (if `hub/src/middleware/rate-limit.ts` is in-memory and needs persistence).
- **Confirmed not in `package.json`.**

### 3.3 Golden-vector test sharing
- Plan: create `hub/test/fixtures/titanium-vectors.json` with N test JWTs (valid, expired, wrong-aud, wrong-iss, tampered sig, `alg: none`, `alg: HS256` masquerading, post-rotation `kid`) + expected verify outcomes. Submit the same fixtures upstream to `@titanium/license-client` (TS client) for cross-validation. Catches subtle clock-skew / kid-rotation / error-taxonomy drift.

---

## 4. Endpoint surface — additions + modifications

### 4.1 NEW endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/login/request-link` | none | Email-only. Always 200 (enumeration prevention). Rate: 3/min/IP + 5/hr/email |
| GET | `/api/auth/login/callback?token=...` | magic-link JWT | Verifies, applies collision policy, issues `__Host-remo_sid`. Rate: 10/min/IP |
| POST | `/api/auth/logout` | session cookie | Deletes `auth_sessions` row, clears cookie |
| POST | `/webhooks/titanium/license-changed` | HMAC | (optional) Invalidates license cache for affected `titanium_subject` |

### 4.2 MODIFIED endpoints
| Method | Path | Change |
|---|---|---|
| POST | `/api/auth/login` | Wrap in `if (config.allowLegacyLogin)` guard. Default `true` during soak. |
| POST | `/api/auth/register` | Disabled (already single-user; first-Titanium-login auto-creates the row) — wrap in `if (config.allowLegacyLogin)` |

### 4.3 UNCHANGED endpoints (load-bearing)
- `/health`, `/api/sentry/*/envelope/`, `/api/coolify/webhook/*`, `/ws/agent`, `/ws/supervisor`, `/openapi.json`, `/docs`.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Titanium uptime affects login | Read ops cached 5 min + blocklist real-time; writes degrade gracefully after TTL. Login itself requires Titanium reachable. |
| `@titanium/license-client` TS→TS port subtle drift | Golden-vector tests shared with upstream client. |
| Cookie name collision / SameSite issues with WebSocket | `__Host-` prefix forces strict cookie semantics. WS upgrade reads cookie at handshake; works on same-origin. |
| `auth_sessions` table name clash with existing `sessions` | RENAMED to `auth_sessions` — documented as load-bearing in CONTEXT.md §specifics + this RESEARCH §1.5. |
| Bcrypt path + Titanium path issue different "user identity" formats | BOTH paths issue the same `__Host-remo_sid` cookie + same `auth_sessions` row. Downstream middleware never branches on auth-source. |
| Magic-link delivery latency via emails4agents | Pre-warm SES sending domain reputation in staging. Magic-link valid 15 min — comfortable buffer. |
| `JWT_SECRET` rotation breaks live sessions at D14 | Acknowledged: D14 cutover forces re-login. Pre-announced to users D7. |
| Agent `api_keys` regression | Zero-regression test in 16-row matrix is load-bearing acceptance. CI gate. |

---

## 6. Open questions (carry into TEMPLATE.md FAQ)

1. **Keygen Product ID for remo-code** — exists in Titanium yet?
2. **License model** — per-user vs per-tenant (Keygen Group)?
3. **Webhook availability** — `license.changed` shipped today?
4. (Audit confirmed: rate-limit infra exists at `hub/src/middleware/rate-limit.ts`. Planner extends. Not user-facing.)

---

## 7. Cross-app TEMPLATE.md sketch

This phase produces `.planning/phases/07-titanium-auth-cutover/TEMPLATE.md` — the user's primary deliverable. It distills:

- **Stack-agnostic checklist** (10 stages A–J in the same order).
- **Per-stack adapters:**
  - **Bun + Hono** (this phase — reference impl).
  - **Next.js (App Router)** — route handlers, middleware via `app/middleware.ts`, cookies via `cookies()` from `next/headers`.
  - **Express** — `cookie-parser` + `helmet` + `express-rate-limit`; same `jose` lib.
  - **FastAPI** — `pyjwt[crypto]` + `cryptography` + `redis-py`; magic-link flow port (the architect's claude-code-cli-gateway impl IS the reference).
  - **Tauri** (desktop) — sessions are local file-backed; license verify still calls Keygen JWKS. Magic-link redirect handled via `tauri-plugin-deep-link`.

- **Email-collision policy** verbatim — copy-paste-ready into any consuming app's mapping job.
- **D0/D7/D14/D14+1 schedule** — copy-paste calendar.
- **Exclusion list pattern** — guidance: every app lists its public/webhook/agent surfaces explicitly, opt-OUT of gating, not opt-IN.
- **16-row test matrix** — generalized.

---

*Research: 07-titanium-auth-cutover*
*Produced: 2026-05-25*
