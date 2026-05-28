# Auth model (Phase 07 — Titanium Licensing cutover)

This doc describes the **post-Phase 07** auth model for the remo-code hub. The phase replaces bcrypt + JWT user-auth with **Titanium Licensing** (Keygen-backed) magic-link login plus opaque cookie sessions, and gates feature endpoints on a synced `license_status` mirror.

The legacy bcrypt/JWT path remains in the codebase behind `ALLOW_LEGACY_LOGIN=true` for one release as the documented rollback. Phase 07.5 deletes it.

---

## At a glance

| Concern | Phase 06 and earlier | Phase 07 (this doc) | Phase 07.5 (next) |
|---|---|---|---|
| User identity | local bcrypt `password_hash` | Titanium `titanium_subject` (Keygen sub) | same |
| Session | signed JWT (HS256) in `Authorization: Bearer` | opaque cookie token, sha-256 in `auth_sessions` | same |
| First login | `POST /api/auth/register` | `POST /api/auth/request-link` → email → `GET /api/auth/callback?token=…` | same |
| License check | none | `license_gate` middleware reads `users.license_status` | same |
| Agent auth (`/ws/agent`) | `api_keys` (sha-256 hashed) | **unchanged** | unchanged |
| Legacy login | the only path | gated behind `ALLOW_LEGACY_LOGIN=true` | **removed** |
| `password_hash` column | source of truth | unused, present | **dropped** |
| `JWT_SECRET` env | required | required (legacy + GitHub App helper) | removed |

---

## Magic-link flow

```
Browser                  Hub                        Titanium / Keygen           Mail
   │                      │                                │                      │
   ├─ POST /api/auth/request-link {email} ──► validate email                       │
   │                      │                                │                      │
   │                      ├─ mint magic_link_token (jose EdDSA, jti, 15 min) ────► │
   │                      │                                │                      │
   │                      ├─ store jti → "pending" in Redis (single-use)           │
   │                      │                                │                      │
   │                      ├─ send link email via emails4agents ─────────────────► [user]
   │                      │                                                       │
   ◄── 200 {ok: true} ────┤                                                       │
   │                                                                              │
[user clicks link]                                                                │
   │                                                                              │
   ├─ GET /api/auth/callback?token=… ────►                                        │
   │                      ├─ jose.verify(token) (EdDSA, jwks-cached)              │
   │                      ├─ Redis SETNX jti → "used"   (replay = 401)            │
   │                      ├─ Titanium.validateLicense(titanium_subject) ─────────►│
   │                      │                                ◄─ {status, license_id}│
   │                      ├─ upsert users row, write license_* fields             │
   │                      ├─ createAuthSession(userId) → opaque cookie            │
   │                      │   Set-Cookie: remo_sess=<token>; HttpOnly; Secure;    │
   │                      │   SameSite=Lax; Path=/                                │
   ◄── 302 / ─────────────┤                                                       │
```

### Session cookie

- Name: `remo_sess`
- Value: random 32 bytes, base64url-encoded. The raw token is sent to the browser exactly once; only `sha256(token)` is stored in `auth_sessions.token_hash`.
- Flags: `HttpOnly`, `Secure` (prod), `SameSite=Lax`, `Path=/`.
- Sliding refresh: every authenticated request bumps `last_seen_at` and extends `expires_at` if older than half the lifetime.
- Idle TTL: 30 days. Absolute TTL: 90 days.
- Logout (`POST /api/auth/logout`) deletes the row and clears the cookie.
- `purgeExpiredAuthSessions()` runs hourly to GC expired rows.

### CSRF model

All state-changing routes (`POST`/`PATCH`/`PUT`/`DELETE`) check **double-submit cookie**:

- On any cookie-session request, the hub sets a `csrf_token` cookie (non-`HttpOnly`, `SameSite=Lax`) with a random 32-byte value.
- The web client reads `csrf_token` from `document.cookie` and forwards it as `X-CSRF-Token: <value>` on every mutation.
- The hub compares the header to the cookie using `crypto.timingSafeEqual`. Mismatch = 403.
- Routes called only with the bearer-token legacy path skip the check (legacy clients never had it). The web client always attaches `Authorization: Bearer <jwt>` whenever a legacy JWT is present in localStorage, even if a stale `csrf_token` cookie is also present — this guarantees `csrfGuard`'s Bearer-bypass fires for legacy-auth users who logged in via magic-link previously and still have the cookie around.
- **Self-heal:** if a request carries a valid `__Host-remo_sid` cookie but no `csrf_token` cookie (drift state — csrf cookie cleared, expired, or never set), `csrfGuard` re-issues a fresh `csrf_token` in the response and allows the current request through. Safe because the session cookie's `SameSite=Lax` already blocks cross-site mutating requests, and the session token is verified against the DAL before self-heal triggers. Without this branch, the very next mutating call (e.g. `POST /api/account/coolify-webhook-secret/rotate`) would 403 with no in-app recovery short of logout+login.

### Re-auth (step-up) gate

`hub/src/auth/reauth.ts` enforces a short window of "recently authed". Sensitive ops require it:

- API-key create / delete
- Email change
- Account delete

**Window: 15 min** (default `maxAgeSeconds = 900`). Measured against `auth_sessions.created_at`, which is set fresh by the magic-link callback. Under Titanium magic-link there is no password to re-enter, so a fresh login IS the step-up signal. The previous 5-min default left users stranded when they browsed for >5 min between login and the sensitive op (no recovery path other than re-running the full magic-link round-trip). 15 min matches typical step-up windows (sudo TTL, banking) while still bounding the post-login elevated-write surface.

**Fresh-session invariant.** `GET /api/auth/login/callback` ALWAYS issues a brand-new `auth_sessions` row and revokes any inbound session cookie's row first (`deleteAuthSession(inboundToken)`, best-effort). This guarantees that "log out + log back in" — or even "click a new magic link while a stale cookie is still present" — produces a fresh `created_at` and resets the 15-min step-up window. Without the explicit revoke, the orphan row would linger until `purgeExpiredAuthSessions` swept it up. Both the callback and `POST /api/auth/logout` log the resulting session lifecycle (`fresh_session_expires=…`, `session_row_deleted=true`) so step-up gate behavior is observable in hub logs.

When the gate fails (`401 re_auth_required`), the web client prompts for a fresh magic-link and resumes the original action on success.

---

## License gating

### How it works

`hub/src/license-gate.ts` is a middleware factory mounted on every license-gated route group. On each request it:

1. Reads `users.license_status`, `license_id`, `license_checked_at` from the row (via `getUserLicenseFields`).
2. If the row is missing or `license_checked_at` is older than `TITANIUM_LICENSE_CACHE_TTL_SECONDS` (default 300), it calls `titaniumClient.validateLicense(subject)` and writes the result back through `updateLicenseStatus`.
3. If `license_status !== 'active'`, it returns **402 Payment Required** with a JSON body `{ error, status, portal_url }`.

The webhook `POST /webhooks/titanium/license-changed` lets Titanium push state changes immediately so the user does not have to wait for the TTL to expire.

`/ws/client` mutations (`send_message`, `permission_response`, `question_response`) are gated identically to HTTP mutations — refused with `{type:'send_refused', reason:'license_inactive'}` when `license_status !== 'active'`. Read-only WS ops (`subscribe`, `pong`) are exempt. License state is cached on the connection, opportunistically refreshed past the same TTL.

### Exclusion list (NEVER license-gated)

These routes are deliberately **outside** the license gate. Removing any of them from this list breaks the rollback path or creates a circular dependency.

| Route | Why excluded |
|---|---|
| `POST /api/auth/request-link` | A user with no license must still be able to log in to see *why*. |
| `GET /api/auth/callback` | Same. |
| `POST /api/auth/logout` | Logging out must always work. |
| `POST /api/auth/login` (legacy, gated) | Same as above for the dual-auth window. |
| `POST /api/auth/register` (legacy, gated) | Same. |
| `GET /api/profile` | Profile read is needed to render the "license expired" page. |
| `PATCH /api/profile` | User must be able to update email/timezone before re-purchasing. |
| `GET /api/profile/license` | **It IS the license-status endpoint.** Gating it on itself is a circular dep. |
| `GET /api/profile/cost-today` | UI dependency that has nothing to do with license state. |
| `GET /healthz` | Coolify health checks. |
| `POST /api/sentry/:project_id/envelope/` | Sentry intake is keyed on `sentry_key`, not user session. |
| `POST /api/coolify/webhook/:user_id` | Webhook keyed on HMAC + shared secret. |
| `POST /webhooks/titanium/license-changed` | Webhook keyed on HMAC. **Required for licensing to function** — gating it would deadlock recovery. |
| `/ws/agent` | Agent auth is keyed on `api_keys`, never user license. A user whose license expires can still observe agent traffic; only user-initiated mutations are blocked. |

### Web UI behavior

- `web/src/hooks/useLicense.ts` polls `GET /api/profile/license` every 5 min.
- 404 → silently `unknown` (back-compat with deploys before the endpoint shipped).
- 402 on a feature route → maps to `expired`.
- The license badge in `Layout.tsx` renders color + tooltip from this.

---

## Dual-auth soak (cutover calendar)

| Day | What happens |
|---|---|
| **D0**   | Phase 07 ships. `ALLOW_LEGACY_LOGIN=true` (default). Both cookie-session and bearer-JWT work. Magic-link enabled in the UI. |
| **D7**   | Web build sets `VITE_HIDE_LEGACY_LOGIN=true`. UI no longer shows "Use password instead". The URL still resolves while `ALLOW_LEGACY_LOGIN=true`. Nudge email sent to users who haven't magic-linked yet. |
| **D14**  | Coolify env flip: `ALLOW_LEGACY_LOGIN=false`. Legacy `POST /api/auth/login` and `POST /api/auth/register` return **410 Gone**. Bearer-token requests return 401. Cookie sessions unaffected. Same redeploy rotates `JWT_SECRET` so all legacy JWTs immediately invalidate. **`SESSION_SECRET` is NOT rotated** (would log out new Titanium-cookie users). |
| **D14+1** | Phase 07.5 starts: drop `password_hash`, remove bcrypt, delete `hub/src/auth/password.ts`, remove the `ALLOW_LEGACY_LOGIN` flag + wrapped legacy code, remove `JWT_SECRET` env after `grep` confirms zero remaining uses. |

### D14 runbook

1. Confirm dashboard: `login_failed` rate <2% over the last 24h, zero `link_mismatch` events in `auth_events` over the last 24h.
2. Coolify → remo-code → env vars: set `ALLOW_LEGACY_LOGIN=false`.
3. Coolify → env vars: rotate `JWT_SECRET` to a fresh 64-byte random value. **Leave `SESSION_SECRET` alone.**
4. Trigger redeploy. Wait for health check green.
5. Smoke test:
   - `curl https://app.remo-code.com/api/auth/login -d '{"email":"x","password":"y"}'` → expect 410.
   - Open https://app.remo-code.com in a tab that still holds a legacy JWT in `Authorization` → expect redirect to `/login`.
   - Open a tab with an active cookie session → still works.
6. File the Phase 07.5 follow-up issue (`gh issue create`) with the checklist from the "07.5 follow-up" section below.

---

## Rollback procedure

If the cutover surfaces a regression, the rollback is intentionally one-step:

1. Coolify → env vars: `ALLOW_LEGACY_LOGIN=true`.
2. (Optional) revert the `VITE_HIDE_LEGACY_LOGIN` build var so the UI shows the password fallback again. Rebuild + redeploy the web bundle.
3. **Do NOT roll back `JWT_SECRET`** if it has already been rotated — instead, paste the previous value back into Coolify env. (Keep the value in a password manager during the rotation window.)
4. Users with stale legacy JWTs land on `/login`; they can use password fallback to get back in.
5. New magic-link sessions continue working in parallel.

The rollback works because Phase 07 is purely **additive at the schema layer**: the legacy code paths are still present and functional, just gated.

If `SESSION_SECRET` was accidentally rotated, every Titanium-cookie user is logged out and must magic-link again. There is no DB-side rollback for this — the previous secret is the only way to verify outstanding cookies. Keep `SESSION_SECRET` in a password manager.

---

## Migration runbook

The one-shot script `hub/scripts/migrate-users-to-titanium.ts` (Plan E) backfills `titanium_subject` and `license_status` for existing users.

### Pre-flight

- Runtime env uses the canonical Keygen-prefixed names:
  `TITANIUM_KEYGEN_API_URL`, `TITANIUM_KEYGEN_ACCOUNT_ID`,
  `TITANIUM_KEYGEN_PRODUCT_ID`, and `TITANIUM_KEYGEN_PORTAL_TOKEN`.
- Have `TITANIUM_KEYGEN_PORTAL_TOKEN` (admin scope) in the shell env, NOT in `.env`.
- Have a fresh `pg_dump` of the prod DB.
- Coolify env: confirm `ALLOW_LEGACY_LOGIN=true` and the Titanium env vars are set.

### Steps

1. Dry-run on the disposable test DB: `REMO_E2E_DB_URL=… bun run hub/scripts/migrate-users-to-titanium.ts --dry-run`.
2. Inspect the printed summary:
   - `matched` — user email found in Titanium portal → `titanium_subject` set, `titanium_link_status='linked'`.
   - `pending_verify` — email not found → `candidate_subject` is null, `titanium_link_status='pending_verify'`. User must verify ownership via magic-link before the row is promoted.
   - `errors` — Keygen API errors. Fix before proceeding.
3. Real run on prod: `bun run hub/scripts/migrate-users-to-titanium.ts`.
4. Monitor `auth_events` for `link_mismatch` rows — these indicate a user logged in via magic-link with a subject that does not match the row's `candidate_subject`. Investigate manually.

The script is **idempotent** — running it twice produces the same result.

---

## Mobile finalize endpoint (Phase 12.1)

The mobile Tauri shell cannot directly receive the browser session cookie set
by `GET /api/auth/login/callback` — the OAuth-style hop happens in the system
browser, not the WebView. To bridge that gap, the callback supports an opt-in
`?platform=ios|android` query that triggers a deep-link handoff instead of a
cookie + 302 to `/`.

### Flow

1. The Tauri shell opens `https://app.remo-code.com/api/auth/login/request-link?platform=ios`
   in the system browser (regular magic-link email request — `platform` is
   echoed back through the email link by the SPA / link builder).
2. The user taps the link in their email. The browser hits
   `GET /api/auth/login/callback?platform=ios&token=<jwt>`.
3. The hub verifies the magic-link JWT and reserves the `jti` (same path the
   browser callback uses), then mints a one-time row in
   `auth_handoff_tokens` (60-second TTL, single-use).
4. The hub 302s the browser to `remo-code://auth/callback?token=<opaque>`.
   The OS hands the URL off to the registered Tauri app.
5. The Tauri shell POSTs the opaque token to `/api/auth/finalize-mobile` with
   `Origin: tauri://localhost` (iOS) or `https://tauri.localhost` (Android).
6. The hub consumes the row (atomic `UPDATE … WHERE consumed_at IS NULL`),
   creates a normal `auth_sessions` row via `createAuthSession`, and emits a
   Tauri-variant cookie: `Set-Cookie: remo_sid=…; HttpOnly; Secure;
   SameSite=None; Partitioned; Path=/; Max-Age=…`. The body returns
   `{ ok: true, expires_at, user }`.

### Why a separate cookie name

The default browser cookie uses the `__Host-` prefix, which forbids
`SameSite=None`. The Tauri WebView is a cross-origin context (the SPA at
`app.remo-code.com` is "third-party" from `tauri://localhost`'s perspective),
so we need `SameSite=None; Secure; Partitioned`. The unprefixed `remo_sid`
name carries those attributes without violating the `__Host-` contract.

Both names are read by `readSessionCookie` and
`parseSessionCookieFromHeader`, so the WS upgrade and middleware paths handle
either cookie transparently.

### Audit log

`recordAuthEvent` writes three new event types:

- `mobile_handoff_minted` — the callback minted a one-time token. Metadata
  carries `{ platform: 'ios' | 'android' }`.
- `mobile_finalize` — `finalize-mobile` succeeded. Metadata carries `origin`.
- `mobile_finalize_failed` — invalid token, expired, double-consume, or
  missing user. Metadata carries `reason`.

### Exclusion list

`/api/auth/finalize-mobile` is under the existing `/api/auth/*` exclusion in
`hub/src/index.ts`, so it skips both the JWT catch-all and the
`requireActiveLicense` gate.

### Schema

```sql
CREATE TABLE IF NOT EXISTS auth_handoff_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT 'mobile_handoff',
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_handoff_tokens_hash
  ON auth_handoff_tokens(token_hash);
```

The opaque token is sha-256-hashed before storage (same pattern as
`auth_sessions.id` and `api_keys.key_hash`).

See [docs/mobile-client.md](mobile-client.md) for the full Phase 12 architecture
including `.well-known/*` routes and the Tauri-origin CORS additions.

---

## Phase 07.5 follow-up (DO NOT do during Phase 07)

Filed as a separate GitHub issue at the end of Phase 07 with this checklist:

- [ ] Drop `users.password_hash` column (after `grep` confirms zero remaining reads).
- [ ] Remove `bcrypt` from `package.json` + `bun.lockb`.
- [ ] Delete `hub/src/auth/password.ts`.
- [ ] Remove `ALLOW_LEGACY_LOGIN` parsing + wrapped code in `hub/src/api/auth.ts`, `hub/src/auth/middleware.ts`, `hub/src/ws/client.ts`, `hub/src/config.ts`.
- [ ] Remove the `legacy_login_disabled` 410 handlers (the routes themselves go).
- [ ] After `grep` confirms `JWT_SECRET` is unused (likely needs GitHub App helper rewired first), drop the env var.
- [ ] Update this doc's "At a glance" table to reflect the final Phase 07.5 state and prune the dual-auth references.

---

## Related docs

- [README.md](../README.md) — quick-start including magic-link login example
- [docs/scheduled-tasks.md](scheduled-tasks.md) — scheduled-task dispatch (license-gated)
- [docs/error-capture.md](error-capture.md) — error-capture intake (NOT license-gated)
- [docs/grid-view.md](grid-view.md) — multichat grid (license-gated)
- [docs/codex-and-rootless.md](codex-and-rootless.md) — Codex runner + rootless sessions
- [docs/coolify-webhook-migration.md](coolify-webhook-migration.md) — Coolify webhook ingress (pattern shared with Titanium webhook)
- Global rules: [`C:\Users\artic\.claude\CLAUDE.md`](file:///C:/Users/artic/.claude/CLAUDE.md) rules #16, #17, #18 — Titanium Licensing as the auth/billing default, Postgres on Coolify as the DB default, Supabase deprecation
