# Titanium Licensing Auth Cutover — Reusable Template

**Version:** 1.0 (extracted from remo-code Phase 07, 2026-05-25)
**Lineage:** carries forward the architect template at `C:\Users\artic\.claude\plans\cheeky-watching-crystal.md` (claude-code-cli-gateway Phase 02, FastAPI). Stack-agnostic shape with per-stack adapters.
**Authority:** global rule #16 — Titanium Licensing is the auth + billing default for every app in the portfolio. This template is the canonical procedure.

---

## 1. What this template is

A step-by-step procedure for cutting any app in the user's portfolio over from a local auth provider (bcrypt + JWT, Supabase Auth, NextAuth, Auth0, Clerk, Firebase Auth, etc.) onto **Titanium Licensing** for identity + license-gating. It captures the load-bearing architectural decisions, the email-collision policy, the dual-auth soak schedule, the security envelope (CSRF + headers + rate limits), and the rollback path. Per-stack adapters cover Bun + Hono, Next.js, Express, FastAPI, and Tauri.

**Expected outcome.** After running this template end-to-end, the target app:

- Uses Titanium magic-link as the sole identity path (no local passwords).
- Holds a server-side opaque session in an `auth_sessions` table identified by a `__Host-<app>_sid` cookie.
- License-gates every mutating REST endpoint and every mutating WS message; explicit exclusion list for public/agent/webhook surfaces.
- Verifies Titanium license JWTs locally via JWKS (EdDSA pinned); per-request verify is cheap.
- Real-time revocation through Redis blocklist + 5-min TTL license cache.
- Persists every auth-relevant event to `auth_events`.
- Ships CSRF (double-submit cookie), security headers (HSTS/CSP/COOP/CORP), rate limits, magic-link single-use enforcement, and admin force-reissue.

**What this template does NOT cover.**

- Changing identity providers other than Titanium (Titanium is mandated by rule #16 — if you find yourself wanting Auth0/Clerk/etc., stop).
- Full SSO/SAML federation (Titanium is magic-link, period).
- Multi-tenant role explosion / per-tenant ACL trees (`users.role` stays local).
- Authorization beyond a coarse `role` column (Titanium is identity + licensing, not authz).
- Hub-side OAuth refresh-token storage for downstream services (forbidden by rule #16).
- Dropping the legacy `password_hash` column and removing `bcrypt` — that's the **follow-up Phase X.5**, never the cutover phase itself.

---

## 2. Pre-flight (stack-agnostic)

Run these before opening the cutover branch.

### 2.1 Confirm rule-#17 DB posture

Target app is on **Postgres hosted on Coolify** (per global rule #17). If yes, the additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migrations in Stage B work as written. If the app is still on SQLite (e.g. early-stage local tooling) or any other engine, document the dialect difference and rewrite the schema deltas — most are vanilla SQL, but `JSONB`, `TIMESTAMPTZ`, `BIGSERIAL`, and partial indexes need translation.

### 2.2 Provision Keygen Product + Policy + Portal token

Titanium runs Keygen CE. One **Keygen Product** per app, one **Policy** per pricing tier, one **portal token** per product (the runtime read token).

```bash
# 1. Create Product (one per app)
curl -X POST "$TITANIUM_KEYGEN_API_URL/v1/accounts/$TITANIUM_KEYGEN_ACCOUNT_ID/products" \
  -H "Authorization: Bearer $TITANIUM_KEYGEN_ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -H "Accept: application/vnd.api+json" \
  -d '{"data":{"type":"products","attributes":{"name":"<APP NAME>","distributionStrategy":"LICENSED"}}}'
# → save the returned id as TITANIUM_KEYGEN_PRODUCT_ID

# 2. Create Policy (e.g. "Pro" — one license per user, no machine binding)
curl -X POST "$TITANIUM_KEYGEN_API_URL/v1/accounts/$TITANIUM_KEYGEN_ACCOUNT_ID/policies" \
  -H "Authorization: Bearer $TITANIUM_KEYGEN_ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -H "Accept: application/vnd.api+json" \
  -d '{"data":{"type":"policies","attributes":{"name":"Pro","duration":null,"strict":false,"floating":true,"maxMachines":null,"requireFingerprintScope":false,"requireProductScope":true,"scheme":"ED25519_SIGN"},"relationships":{"product":{"data":{"type":"products","id":"<PRODUCT_ID>"}}}}}'
# → save the returned id as TITANIUM_KEYGEN_POLICY_ID

# 3. Mint product-scoped portal token (runtime read)
#    NOTE: Keygen CE does NOT accept attributes.name or attributes.permissions on POST /tokens.
#    Use POST /products/:id/tokens with an empty body instead.
curl -X POST "$TITANIUM_KEYGEN_API_URL/v1/accounts/$TITANIUM_KEYGEN_ACCOUNT_ID/products/<PRODUCT_ID>/tokens" \
  -H "Authorization: Bearer $TITANIUM_KEYGEN_ADMIN_TOKEN" \
  -H "Accept: application/vnd.api+json" \
  -d '{}'
# → save the returned token attributes.token as TITANIUM_KEYGEN_PORTAL_TOKEN
```

The `TITANIUM_KEYGEN_ADMIN_TOKEN` is used **only by the migration script** (Stage E) — it is NEVER loaded by the running app.

### 2.3 Coolify env vars (set BEFORE deploying the cutover code)

```
TITANIUM_KEYGEN_API_URL=https://keygen.titaniumlabs.us
TITANIUM_KEYGEN_ACCOUNT_ID=<uuid>
TITANIUM_KEYGEN_PRODUCT_ID=<uuid>
TITANIUM_KEYGEN_POLICY_ID=<uuid>
TITANIUM_KEYGEN_PORTAL_TOKEN=<runtime read token>
TITANIUM_LICENSE_CACHE_TTL_SECONDS=300
MAGIC_LINK_SECRET=<32 random bytes, base64>      # openssl rand -base64 32
SESSION_SECRET=<32 random bytes, base64>          # openssl rand -base64 32
TITANIUM_REDIS_URL=redis://<coolify-redis-host>:6379
ALLOW_LEGACY_LOGIN=true                           # flip to false at D14
# emails4agents (rule #7) — magic-link delivery
E4A_API_KEY=<...>
E4A_BASE_URL=https://api.emails4agents.com
E4A_INBOX_ID=<...>
```

Per-app rules:

- `MAGIC_LINK_SECRET` and `SESSION_SECRET` are **per-app** — never share across apps.
- `TITANIUM_KEYGEN_PRODUCT_ID` is per-app (each app is its own Keygen Product).
- `TITANIUM_KEYGEN_ACCOUNT_ID` and `TITANIUM_KEYGEN_API_URL` are shared (one Titanium tenant for the portfolio).
- The four `TITANIUM_*` runtime vars do NOT bypass the gateway pair rule for OAuth-credential apps — they are auth-source config, not service credentials. Service-level OAuth credentials still flow through Ottolax + Claude Gateway per the global MCP architecture.

### 2.4 Map the target app's auth surface

Before writing any code, locate and document:

1. Where is the current login endpoint? (`POST /login`, `POST /api/auth/login`, route handler file)
2. Where is the session token verified on each request? (middleware, dep injection, JWT verify helper)
3. What is the cookie or token storage? (cookie name, `localStorage` key, header name)
4. Is CSRF currently enforced? (most JWT-bearer apps say "no" — be ready to add it)
5. What's the WS auth payload shape? (the WS protocol also gets a CSRF mirror — Stage G)
6. **Public/exclusion routes.** Enumerate every endpoint that MUST NOT be license-gated: health, public webhooks (Stripe/Coolify/Sentry intake/GHL), agent-WS endpoints, OAuth callbacks, public-facing OpenAPI/Scalar docs. **License-gating is opt-out, not opt-in** — anything not on the exclusion list gets gated.

Output a single markdown file `docs/auth-surface-current.md` in the target repo before opening the cutover branch — it will inform Stages C, D, and the exclusion list.

---

## 3. The 10 stages (A–J)

Each stage is one independent commit. Stages run in order (A → B → C → D → E → F → G → H → I → J). Bundling stages defeats the rollback model.

### Stage A — Titanium client foundation

**Goal.** Build the small client that talks to Titanium: JWKS fetch + EdDSA verify, license-key validate, Redis blocklist check, Keygen User CRUD slice. No app integration yet.

**Locked decisions.**

- **JWKS local verify only.** Per-request verify is in-process against cached JWKS — never call Titanium's `/verify` endpoint per request.
- **EdDSA pinned.** Reject `alg: none | HS* | RS* | ES*` outright. Never accept `verify: false`.
- **JWKS cache.** In-memory, indefinite, single-flight refetch on `kid` miss. Warm-cache during boot BEFORE the HTTP listener accepts connections.
- **Claims required:** `iss == TITANIUM_KEYGEN_API_URL`, `aud` includes `TITANIUM_KEYGEN_PRODUCT_ID`, `exp`, `nbf`, `iat` with ±30s clock skew, signature against `kid`-matched key.
- **Redis blocklist** (`titanium:blocklist` set + `titanium:blocklist:<subject>` keys) — checked alongside signature on every verify. Real-time. Fail-CLOSED on Redis outage for mutations; fail-open for reads is a per-app discretion call.
- **Admin token usage.** Migration script only. Never load `TITANIUM_KEYGEN_ADMIN_TOKEN` in app runtime config.

**Acceptance.** Unit tests verify: a valid Titanium-signed JWT passes; a tampered byte fails; an `alg: HS256` JWT with the same payload fails; a JWT after `exp` fails; a blocklisted subject fails. Golden-vector test suite shared with upstream `@titanium/license-client` (TS) catches clock-skew / key-rotation drift across language ports.

**Common pitfalls.** Pulling in a full Keygen SDK when only ~5 endpoints are needed (write your own thin client); using `jose` `jwtVerify` without specifying `algorithms`; forgetting to bound the JWKS fetch timeout (a hung JWKS endpoint kills request latency).

### Stage B — DB schema migration (additive only)

**Goal.** Add columns and tables to support the new identity model, without dropping anything.

**Locked decisions.**

- **Additive only.** No `DROP COLUMN`, no `NOT NULL` removals on existing columns (except `password_hash` which becomes nullable). All `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`.
- **`auth_sessions`, not `sessions`.** If the target app already has a `sessions` table for any non-auth concept (e.g. chat sessions, Claude Code sessions, user-uploaded-job sessions), DO NOT overload it. Name the new table `auth_sessions`. The remo-code incident: a pre-existing `sessions` table meant Claude Code conversation sessions; collision would have been catastrophic.
- **User-table delta.** Add: `titanium_subject TEXT UNIQUE NULL`, `titanium_email TEXT NULL`, `last_titanium_sync_at TIMESTAMPTZ NULL`, `license_status TEXT NULL`, `license_id TEXT NULL`, `license_checked_at TIMESTAMPTZ NULL`, `titanium_link_status TEXT NULL` (`linked|pending_verify|mismatch`), `candidate_subject TEXT NULL`. Drop `NOT NULL` on `password_hash`.
- **New tables.** `auth_events(id BIGSERIAL PK, user_id NULL, event_type TEXT, ip TEXT, user_agent TEXT, ts TIMESTAMPTZ DEFAULT now(), metadata JSONB)` indexed on `(user_id, ts DESC)` and `(event_type, ts DESC)`. `auth_sessions(id TEXT PK, user_id NOT NULL FK CASCADE, created_at, last_used_at, expires_at NOT NULL, ip, user_agent)` indexed on `(user_id)` and `(expires_at)`.

**Acceptance.** Schema migration runs idempotently against a fresh DB and an existing-data DB. Existing app boots cleanly after migration. Existing login still works (no code paths flip yet).

**Common pitfalls.** Adding a foreign key from `auth_sessions.user_id` to `users.id` without `ON DELETE CASCADE` — orphans the session row on user delete. Forgetting `metadata JSONB` (not `TEXT`) on `auth_events` — JSON ops on TEXT are awful.

### Stage C — Login + opaque session swap

**Goal.** Land the magic-link request/callback endpoints and the cookie-backed session middleware. Legacy login still works in parallel.

**Locked decisions.**

- **Server-side opaque sessions, NOT JWT cookies.** Session ID is a 256-bit random opaque token stored in `auth_sessions`. Cookie carries the ID; server resolves to a row. Allows instant server-side revocation.
- **Cookie name `__Host-<app>_sid`.** `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, **no `Domain`** (the `__Host-` prefix mandates this). Per-app prefix — never share `__Host-app_sid` across apps.
- **TTLs.** Idle 60 min (sliding), absolute 7 days (hard cap from `created_at`).
- **Magic-link JWT.** HS256, signed with `MAGIC_LINK_SECRET`, 15-min TTL, single-use `jti`. Mark `jti` used in Redis (`magic_link:used:<jti>` `EX 900`) on first successful callback — subsequent callback with same `jti` rejected even if signature + TTL still valid.
- **Login-enumeration prevention.** `POST /api/auth/login/request-link` **always returns 200** regardless of whether the email maps to a known user. Equal-time response window (e.g. always ≥200ms). Email is only sent when a Keygen User exists; otherwise silent.
- **Re-auth gate.** Mutating ops of elevated impact (token create/rotate/delete, scheduled-task delete-all, secret rotation, etc.) require `session.created_at` within last 5 min — else `401 { error: 're_auth_required' }`.
- **Dual-auth shim.** `POST /api/auth/login` (legacy bcrypt) stays alive behind `ALLOW_LEGACY_LOGIN=true`. Both paths issue the same `__Host-<app>_sid` cookie. Both write to `auth_events`.

**Acceptance.** Magic-link round-trip works against staging Titanium. Same `jti` replayed → 409. Expired magic-link → 401. Unknown email → 200 with no email sent. Idle timeout actually expires after 60 min. Absolute timeout actually expires after 7 days.

**Common pitfalls.** Issuing the cookie WITHOUT `__Host-` prefix and hitting subdomain leak. Storing the session ID hashed in the DB but unhashed in the cookie (then forgetting to hash on lookup). Using `SameSite=Strict` and breaking the magic-link callback (must be `Lax`). Forgetting the equal-time response and exposing user enumeration via timing.

### Stage D — License gating

**Goal.** Land the `require_active_license` middleware. Gate the right routes; explicitly exclude the wrong routes.

**Locked decisions.**

- **Single-track from D0.** Both legacy bcrypt logins AND magic-link logins flow through license gating on every mutating route. A logged-in user with no active Titanium license still gets `402 Payment Required` on mutations.
- **License states.** `ACTIVE` → allow. `EXPIRED < 7d` → read-only grace (GET allowed, mutating returns 402). `EXPIRED ≥ 7d | SUSPENDED | BANNED | missing` → 402 on every gated route.
- **Cache.** In-process 5-min TTL keyed by `titanium_subject`. License JWT verify is local-only against cached JWKS. Blocklist check is ALWAYS live (no cache).
- **Exclusion list (opt-out gating — load-bearing).** `GET /health`, `GET /metrics`, public webhook intakes (Sentry-style, Coolify, Stripe, GHL), agent WS endpoints with their own auth (`api_keys`, HMAC), supervisor connections, OAuth callbacks, public OpenAPI + Scalar UI (`/openapi.json`, `/docs`). Every excluded route must be enumerated in `docs/auth.md` with rationale.
- **Optional `license.changed` webhook receiver.** HMAC-verified. Invalidates the per-subject cache. Skip if Titanium doesn't expose one yet — the 5-min TTL + Redis blocklist already covers revocation.

**Acceptance.** 16-row test matrix (see Stage I) passes against staging. Public webhooks still accept requests without a session cookie. Agent WS still authenticates with `api_keys` unchanged.

**Common pitfalls.** Mounting the license-gate middleware too high in the chain and accidentally gating the health endpoint. Inverting the exclusion list (opt-in gating) and missing one mutating route. Caching the blocklist result. Forgetting that `WS message handlers` also need gating — license-gate applies to BOTH REST mutations AND WS mutating messages.

### Stage E — User migration script

**Goal.** Idempotent one-shot script that maps every existing `users` row to a Keygen User, applies the email-collision policy, and emails each user a magic-link.

**Locked decisions.**

- **Default to `--dry-run`.** Operator opts in with `--apply`. Other flags: `--user-id <id>`, `--batch-size 50`, `--skip-email`, `--limit N`.
- **Email-collision policy (Section 4 — verbatim).** No auto-link on email-match alone. Pending-verify path on collision.
- **Output JSON log.** `migration-log-YYYYMMDD-HHMMSS.json` with one entry per user: action taken, before/after state, errors. Committed to `.planning/phases/<phase>/migration-logs/` after the run.
- **Never delete `users` rows.** Disabled-not-deleted hard rule — any FK from `api_keys.owner_user_id` (or equivalent) to `users.id` breaks if rows vanish before token reissue.
- **Welcome magic-link** uses the same `request-link` flow with header `X-Migration-Welcome: true` so the UI can show a slightly different copy.

**Acceptance.** Dry-run on full prod user set → JSON log diff reviewed → apply on 1 test user → that user receives + clicks magic-link → lands on dashboard. Then batch apply 50/min with 5-min spacing.

**Common pitfalls.** Sending welcome emails before confirming the magic-link callback wiring works (locks users out). Re-running `--apply` and double-sending welcomes (idempotency check on `titanium_subject IS NOT NULL` AND `last_titanium_sync_at > now() - 24h` skips already-sent).

### Stage F — Web UI swap

**Goal.** Replace the password form with a single-input email + "Send magic link" form. Add license badge to header. Attach CSRF + cookie credentials to every fetch.

**Locked decisions.**

- **Login page.** Single email input. Always shows generic success message. No "incorrect password" affordance (no password).
- **Auth callback page.** Handles `/auth/callback?token=...`, calls the hub callback endpoint, redirects to dashboard.
- **Header.** Email + Keygen Policy name + license badge dot (emerald `ACTIVE`, amber `EXPIRED <7d`, red `EXPIRED/SUSPENDED/BANNED`, gray unknown).
- **Remove `localStorage.session`** and any header-based token attachment. Switch every fetch to `credentials: 'include'` and `X-CSRF-Token` header on mutating calls.
- **Remove password-change UI.** Replace with "Manage account in Titanium" link to the per-app Titanium portal.

**Acceptance.** All existing UI flows work end-to-end with the cookie session. No `localStorage.session` references remain in the bundle.

**Common pitfalls.** Forgetting `credentials: 'include'` on a single fetch and getting silent 401s. Caching the CSRF token across logout/login (refetch on session change). Hardcoding the Titanium portal URL (env-driven).

### Stage G — Security hardening

**Goal.** HSTS + CSP + COOP + CORP, rate limits, audit log, force-reissue admin action.

**Locked decisions.**

- **Security headers.** `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`. CSP tightened to `'self'` plus the inline allowances the app actually needs (audit then tighten). `Cross-Origin-Opener-Policy: same-origin`. `Cross-Origin-Resource-Policy: same-origin`. `Referrer-Policy: strict-origin-when-cross-origin`. `X-Content-Type-Options: nosniff`. `X-Frame-Options: DENY`. Strip `Server` header.
- **Rate limits.** `POST /api/auth/login/request-link` → 3/min/IP AND 5/hr/email. `GET /api/auth/login/callback` → 10/min/IP. Token-mutating endpoints → 10/min/user.
- **Audit log writes** to `auth_events`: `login_request`, `login_success`, `login_failed`, `logout`, `link_success`, `link_mismatch`, `license_check_failed`, `csrf_failed`, `session_revoked`, `token_create`, `token_rotate`. IP + UA + ts always populated.
- **Magic-link single-use enforced HARD** at the dispatcher, not at the verifier (verify-then-mark-then-process — replay window must be zero).
- **Force token reissue.** Admin CLI or hub endpoint that flips `is_active=false` on all `api_keys` rows for a user when their Titanium license is BANNED/SUSPENDED. Agent traffic drops at next heartbeat.

**Acceptance.** Security-headers test (curl) shows all headers present. Rate-limit test storms 100 request-link calls and sees a 429 by call 4. Replay of a used magic-link returns 409 even with valid signature.

**Common pitfalls.** Stripping CSP entirely because "the SPA breaks" — audit, then add `'unsafe-inline'` only for the inline-script story you can't fix today; plan Phase X+1 to extract. Sharing a single global rate-limit token bucket across all keys (defeat-able by IP rotation).

### Stage H — Dead code cleanup

**Goal.** Remove all bcrypt + legacy-JWT references from the live code paths, BUT keep `password_hash` column + the `ALLOW_LEGACY_LOGIN` shim alive for the rollback window.

**Locked decisions.**

- **What to remove now (this phase):** the legacy login route handler body (replace with a 410 Gone stub guarded by `ALLOW_LEGACY_LOGIN`), the `_hashPassword`/`_checkPassword` helpers (mark deprecated, retain), inline `localStorage.session` reads/writes on the web side.
- **What to keep until Phase X.5:** `password_hash` column (still nullable, no rows being written), `bcrypt` in `package.json`, the `ALLOW_LEGACY_LOGIN` flag itself.
- **Docs (rule #14).** Update `README.md`, `CLAUDE.md`, `docs/auth.md`, `docs/openapi.json`, `docs/api.md` in the same commit. Per-stack: also update the API surface if the app exposes `/openapi.json` (rule #21).

**Acceptance.** `grep -ri "bcrypt\|JWT_SECRET\|password_hash" hub/src web/src` returns only the guarded fallback shim references and the deprecation markers. App boots with `ALLOW_LEGACY_LOGIN=false` AND with `ALLOW_LEGACY_LOGIN=true` — both work.

**Common pitfalls.** Removing the flag too eagerly and losing the rollback path. Forgetting to update `docs/api.md` and triggering the docs-drift CI (rule #21).

### Stage I — Testing & rollout

**Goal.** Run the 16-row matrix, stage, monitor, declare green.

**Locked decisions.**

- **16-row test matrix** (run against staging BEFORE D0):

  1. Magic-link request for known email → email arrives → callback succeeds.
  2. Magic-link request for unknown email → 200 returned, no email sent, response time matches successful path.
  3. Magic-link token replayed → 409.
  4. Magic-link token expired (>15m) → 401.
  5. Login with `license_status=ACTIVE` → dashboard access.
  6. Login with `license_status=NONE` → 402 with Titanium portal link.
  7. Login with `EXPIRED <7d` → dashboard renders read-only, mutations 402.
  8. License flipped to `BANNED` via webhook → next request 402.
  9. License flipped to `BANNED` w/ no webhook → next mutation 402 within 5 min (TTL).
  10. Token create gated: no license → 402; with license but session >5 min old → 401 `re_auth_required`.
  11. Agent/MCP-server/legacy-API traffic using existing keys → unchanged (zero regression). **Load-bearing acceptance criterion.**
  12. CSRF: POST without `X-CSRF-Token` → 403; mismatched token → 403; matching → 200.
  13. Session revoke (admin action) → next request 401.
  14. Logout → cookie cleared, replayed cookie → 401.
  15. JWKS rotation → next license refresh re-fetches JWKS on `kid` miss; old cached JWTs continue to verify until expiry.
  16. JWT tamper (edit any byte) → 401 + `auth_events` row.

- **Cutover schedule.** See Section 5.

- **Monitoring.** Watch `auth_events` for 30 min post-deploy. No `login_failed` storm + ≥1 `login_success` → green.

**Acceptance.** All 16 rows pass on staging. Production deploy completes the soak schedule.

**Common pitfalls.** Skipping row 11 (agent traffic regression) because "we didn't touch that code" — the load-bearing criterion exists because schema migrations and middleware mount-order changes have caused regressions historically.

### Stage J — Template extraction

**Goal.** This document. After the cutover ships, copy this `TEMPLATE.md` to `~/.claude/plans/titanium-auth-cutover-TEMPLATE.md` so future app cutovers find it without needing the source repo.

---

## 4. Email-collision policy (verbatim — load-bearing)

Magic-link login *is* email verification — the migration job leans into it instead of running a separate verify flow.

Required columns on the users table (Stage B addendum): `titanium_link_status TEXT` (`linked` | `pending_verify` | `mismatch`) and `candidate_subject TEXT`.

| Titanium state at migration time | Action |
|---|---|
| No Keygen User with this email | Create Keygen User; set `titanium_subject`; status=`linked`; send welcome magic-link. |
| Keygen User exists (any license state) | DO NOT auto-link. Set `candidate_subject = keygen.id`; status=`pending_verify`; send verify magic-link. On first successful callback, promote `candidate_subject` → `titanium_subject`, status=`linked`. |
| Keygen User exists but `email_verified=false` in Keygen | Treat as "no user" — refuse to link; surface in migration-log; require the user to verify in Titanium first. |

In the login callback (language-agnostic pseudocode — match your stack):

```
on GET /api/auth/login/callback?token=...:
  claims = verify_magic_link(token)         # HS256, MAGIC_LINK_SECRET, single-use jti
  local_row = users.find_by_email(claims.email)
  if local_row.titanium_link_status == 'pending_verify':
      if local_row.candidate_subject == claims.keygen_user_id:
          promote_to_linked(local_row)      # titanium_subject := candidate_subject; status := 'linked'
      else:
          log_auth_event('link_mismatch', { user_id: local_row.id })
          return 409
  create_session(local_row); set_cookie('__Host-<app>_sid'); redirect('/')
```

**Rationale.** Auto-linking on email match alone trusts that whoever controls the email in the target app also controls it in Titanium — true in practice but the one time it isn't is an ATO bug. One extra email per migrated user removes the entire class.

This policy is load-bearing for **every consuming app**, not just the one you're migrating today.

---

## 5. D0 / D7 / D14 / D14+1 cutover schedule (verbatim)

| Day | State |
|---|---|
| **D0** | Magic-link is the default at `/login`. "Use password instead" link still visible (bcrypt path live). Both paths issue the same `__Host-<app>_sid` session cookie. Both write to `auth_events`. **License gating active from D0 on BOTH paths.** |
| **D0–D3** | Migration script runs `--apply` in batches (50/batch, 5-min spacing). Operator watches `auth_events` for `login_failed` storms + `link_mismatch` events. |
| **D7** | UI hides the password fallback link (URL still resolves if `ALLOW_LEGACY_LOGIN=true`). Nudge email sent to users who haven't magic-linked yet. |
| **D14** | Legacy `POST /api/auth/login` returns `410 Gone` (or 404 — operator picks). `ALLOW_LEGACY_LOGIN` flag stays present + functional for one release as the rollback path. Cutover phase declared green. |
| **D14+1 (Phase X.5)** | Drop `password_hash` column, remove `bcrypt` dep, delete `_hashPassword`/`_checkPassword`, remove `ALLOW_LEGACY_LOGIN` flag, finalize `JWT_SECRET` → `SESSION_SECRET` rotation. |

**Important:** dual-auth covers identity only. License gating is single-track from D0 — a legacy-logged-in user with no active Titanium license still gets `402` on mutating routes. Titanium-uptime and app-uptime are **decoupled for read, coupled for write** (5-min TTL cache + Redis blocklist absorb short Titanium outages for read ops; writes degrade after the TTL).

---

## 6. Rollback playbook

The cutover is designed for a free rollback during the soak window. Two levers:

1. **Feature-flag flip (preferred).** Set `ALLOW_LEGACY_LOGIN=true` in the app's Coolify env, redeploy. Legacy `POST /api/auth/login` returns to service. Existing users who haven't yet magic-linked can log in via bcrypt. New magic-link sessions remain valid (they don't depend on the flag).
2. **Container image revert.** Coolify "Rollback" to the pre-cutover image. DB is additive — nothing to undo. Old `password_hash` column intact. Any user who switched to magic-link mid-window loses their session and must re-bcrypt-login (acceptable; rare).

**Hard rule.** Do NOT drop `password_hash` or remove `bcrypt` until ≥14 days green with the flag flipped to `false`. That's Phase X.5, never the cutover phase.

**Post-soak rollback.** Once Phase X.5 has run, rollback requires restoring the `password_hash` column from a backup AND re-deploying the bcrypt code. Treat post-X.5 as a one-way door.

---

## 7. Anti-patterns

What NOT to do during the cutover. Each is a real foot-gun.

- **Don't auto-link by email match alone.** ATO vector. Use the email-collision policy (Section 4). Always.
- **Don't store refresh tokens on the server.** Global rule #16. The portal token is a static service token, not a refresh token. Magic-link JWTs are short-lived single-use, also not refresh tokens.
- **Don't gate the WebSocket *connection*.** Gate mutating *messages*. Connections should authenticate (open the socket with the session cookie or agent `api_key`); license-gate runs at message-dispatch time so a read-only license can still hold an open socket.
- **Don't use Titanium remote `/verify` per request.** JWKS local-verify is the load-bearing perf decision. Per-request remote verify defeats the whole architecture.
- **Don't introduce a new auth provider.** Global rule #16 is non-negotiable: Titanium for new apps, with the migration nuance that existing apps keep their current auth in place until the dedicated cutover phase. No Supabase Auth, NextAuth, Auth0, Clerk, Firebase Auth, Lucia, etc.
- **Don't bundle stages.** One commit per A–J. Bundling defeats the rollback model (you can't revert just Stage F without reverting Stage G if they share a commit).
- **Don't share `MAGIC_LINK_SECRET` or `SESSION_SECRET` across apps.** Per-app. A leaked secret should compromise one app, not the portfolio.
- **Don't share the `__Host-` cookie name across apps.** Per-app prefix (`__Host-remo_sid`, `__Host-cgw_sid`, `__Host-effortr_sid`, etc.).
- **Don't centralize JWT shape across apps.** Each app owns its own context vars. Cross-app JWT reuse is a versioning trap.
- **Don't add an ORM "while we're here."** Karpathy rule #11. Surgical migration. ORM swap is its own phase.
- **Don't push `role` into Titanium claims.** Titanium is identity + licensing. Authz stays local.
- **Don't drop `password_hash` in the same phase as the cutover.** Phase X.5, separate commit, after ≥14 days green.

---

## 8. Per-stack adapters

Each adapter section names the leading reference implementation, the file map, the library choices, and the middleware composition pattern.

### 8.1 Bun + Hono — reference: remo-code Phase 07

**Reference repo.** `C:\Users\artic\GitHub\remo-code` (Phase 07 branch + `main` post-merge).

**File map.**

- `hub/src/titanium-client.ts` — JWKS fetch + EdDSA verify + license-key validate + blocklist check + Keygen User admin slice.
- `hub/src/session.ts` — opaque session create/verify/extend/delete + cookie ops.
- `hub/src/license-gate.ts` — middleware applied via `app.use(...)` after the auth catch-all and before route handlers.
- `hub/src/csrf.ts` — double-submit cookie helpers + dependency.
- `hub/src/middleware/security-headers.ts` — HSTS/CSP/COOP/CORP/etc.
- `hub/src/middleware/rate-limit.ts` — in-process token bucket (audited first; minimal impl).
- `hub/src/api/auth.ts` — `request-link` / `callback` / `logout`.
- `hub/src/api/webhooks-titanium.ts` — optional HMAC-verified `license.changed` receiver.
- `hub/scripts/migrate-users-to-titanium.ts` — Stage E.
- `hub/src/db/schema.sql` — additive migration.
- `hub/src/ws/client.ts` — WS-side CSRF mirror on mutating messages; cookie-authenticated handshake.
- Web: `web/src/pages/Login.tsx`, `web/src/pages/AuthCallback.tsx`, `web/src/lib/hubFetch.ts`.

**Libraries.**

- `jose` — EdDSA + JWKS verify. Zero deps. The TS upstream of `@titanium/license-client` also uses `jose` — golden-vector sharing is trivial.
- `ioredis` — Redis client.
- Hono's built-in cookie helpers (`getCookie`, `setCookie`) — no extra dep.

**Middleware composition.**

```
app.use('*', securityHeaders())
app.use('/api/*', cors(...))                  // existing
// public/exclusion-list routes mounted BEFORE the auth catch-all
app.route('/api/sentry/:project_id/envelope', sentryIntake)
app.route('/api/coolify/webhook/:user_id', coolifyWebhook)
app.route('/openapi.json', openApi)
app.route('/docs', scalarUi)
// auth catch-all
app.use('/api/*', sessionMiddleware())         // resolves cookie → user (or 401)
app.use('/api/*', licenseGate())               // 402 on bad license; read-only grace handled inside
app.use('/api/*', csrfMiddleware())            // 403 on bad CSRF for mutating verbs
// route handlers
app.route('/api/scheduled-tasks', scheduledTasks)
// ...
```

WS auth: `/ws/agent` is mounted entirely OUTSIDE the catch-all and uses `api_keys` unchanged. `/ws/client` reads the session cookie on handshake, and the message dispatcher (in `ws/client.ts`) gates mutating message types through `licenseGate()` + CSRF.

### 8.2 Next.js (App Router) — reference: TBD

**File map.**

- `src/middleware.ts` — top-level Edge/Node middleware. Mounts `securityHeaders`, resolves session cookie, applies `licenseGate` for the matcher of mutating route segments.
- `src/app/api/auth/login/request-link/route.ts`, `.../callback/route.ts`, `.../logout/route.ts`.
- `src/lib/titanium-client.ts` — JWKS + verify + blocklist.
- `src/lib/session.ts` — uses `cookies()` from `next/headers` for read/write.
- `src/lib/csrf.ts` — double-submit cookie + Server Action wrapper.
- `src/app/(auth)/login/page.tsx`, `src/app/(auth)/auth/callback/page.tsx` — UI.
- `migrations/*.sql` — additive.

**Libraries.** Same as Bun/Hono: `jose`, `ioredis`. Cookie API: `cookies()` from `next/headers` (Server Components / Route Handlers); the `Response.cookies.set()` for Middleware writes.

**Cookie naming.** `__Host-<app>_sid` — must include `Path=/` and no `Domain` (NextResponse default omits Domain; verify).

**Matcher pattern.** Use `middleware.ts` `config.matcher` to scope the auth/license/CSRF middleware to `/api/:path*` and the dashboard segment; exclude `/api/health`, public webhooks, `/api/auth/login/:path*`, `/api/openapi`.

### 8.3 Express (Node) — reference: TBD

**File map.**

- `src/middleware/session.ts`, `license-gate.ts`, `csrf.ts`, `security-headers.ts`.
- `src/lib/titanium-client.ts`.
- `src/routes/auth.ts` — `request-link`, `callback`, `logout`.
- `scripts/migrate-users-to-titanium.ts`.

**Libraries.** `jose`, `ioredis`, `cookie-parser` (for cookie read on the request side; write via `res.cookie(...)`).

**Middleware composition.**

```js
app.use(securityHeaders());
app.use(cookieParser());
// public/exclusion-list routes BEFORE auth
app.use('/api/sentry', sentryIntake);
app.use('/api/coolify/webhook', coolifyWebhook);
// auth chain
app.use('/api', sessionMiddleware);
app.use('/api', licenseGate);
app.use('/api', csrfMiddleware);
// handlers
app.use('/api/scheduled-tasks', scheduledTasks);
```

### 8.4 FastAPI (Python) — reference: claude-code-cli-gateway Phase 02

**Reference repo.** `C:\Users\artic\GitHub\claude-code-cli-gateway` (Phase 02 cutover). This is the **original** architect template — the FastAPI implementation predates the TS port.

**File map** (from the architect template):

- `app/titanium_client.py` — JWKS fetch (`async fetch_jwks`), `validate_license_jwt`, `lookup_user_by_email`, `create_user`, `get_active_license_for_user`, `fetch_license_jwt`, `check_blocklist`. Timeouts 5s connect / 10s read.
- `app/session.py` — `create_session`, `get_session`, `revoke_session`, `revoke_all_for_user`.
- `app/license_gate.py` — `require_active_license` and `require_license_for_writes` deps.
- `app/csrf.py` — `require_csrf()` dep.
- `app/dashboard.py` — `request-link` / `callback` / `logout` endpoints + magic-link HTML SPA.
- `scripts/migrate_users_to_titanium.py` — Stage E.

**Libraries.**

- `pyjwt[crypto]>=2.8` — EdDSA + JWKS verify.
- `cryptography>=42` — required for `pyjwt[crypto]` Ed25519.
- `redis>=5.0` — blocklist + magic-link `jti` + license cache + rate-limit buckets.
- `slowapi` — rate limiting (extend existing).
- `python-multipart` — FastAPI form parsing (verify before adding).

**Middleware/Dep composition.** FastAPI uses dependency injection per route, not middleware chain:

```python
@router.post("/api/scheduled-tasks", dependencies=[Depends(require_active_license), Depends(require_csrf)])
async def create_scheduled_task(...):
    ...
```

Exclusion list is implicit (deps not attached). `security_headers` is a single global middleware on the FastAPI app.

**Same invariants apply.** EdDSA pinned, JWKS local verify, 5-min TTL cache, Redis blocklist real-time, opaque `__Host-<app>_sid` session, double-submit CSRF cookie, login-enumeration prevention with equal-time response.

### 8.5 Tauri (desktop)

**Special considerations.** Desktop apps don't run an HTTP server (no inbound port), so the magic-link callback flow becomes a browser-mediated handshake.

**Magic-link flow.**

1. App opens the system browser to `https://<license-portal-url>/login?app=<app-name>&callback=<scheme>`.
2. User completes magic-link in browser.
3. Callback hits either (a) a deep-link / URL-scheme handler registered by Tauri (`tauri://localhost/callback?token=...`), or (b) a short-lived localhost listener spun up by the app on a randomized high port and torn down after callback.
4. Token is exchanged for the session, then **stored in the OS keyring** (Tauri keyring plugin, not `localStorage` and not a plain file).

**Storage.**

- Session token / Titanium subject → OS keyring (Windows Credential Manager / macOS Keychain / Linux libsecret) via `tauri-plugin-stronghold` or `tauri-plugin-keyring`.
- License JWT cache → SQLite (vanilla local-cache use case per rule #17 — SQLite is fine for desktop-local stores).
- **Never** put the session token in `localStorage` or a plain JSON file on disk.

**License-gate.** Runs in the Tauri Rust core, NOT in the WebView. The WebView receives a license-status push and disables UI affordances accordingly, but the Rust core is the source of truth — defense in depth against a tampered front-end.

**Libraries.** `jose` (TS side, in the WebView, for verifying push messages from the core), Rust-side: `jsonwebtoken` crate for the core verifier, `tauri-plugin-stronghold` for keyring, `redis` crate optional (most desktop apps skip blocklist and rely on TTL + offline-grace).

**Cutover schedule deviation.** Desktop apps can't be "redeployed in 5 minutes" — D14 maps to "next release" in the app's update channel. Plan dual-auth window in releases, not days.

---

## 9. Appendix — known Titanium / Keygen API quirks

These trip up first-time integrators. Cite source paths in each note.

- **`POST /tokens` in Keygen CE does NOT accept `attributes.name` or `attributes.permissions`.** Use `POST /products/:id/tokens` with an empty `{}` body to mint a product-scoped portal token. The architect template's `cheeky-watching-crystal.md` Stage A2 documents this. Hitting the wrong endpoint returns a confusing 400; use the per-product endpoint.

- **No `license.changed` webhook as of 2026-05.** Titanium-licensing doesn't emit a `license.changed` webhook in CE today. Plan for the 5-min TTL cache + real-time Redis blocklist as the primary revocation path. If/when Titanium ships the webhook, wire `POST /webhooks/titanium/license-changed` (HMAC-verified) to invalidate the per-subject cache instantly. Flag in Titanium's own backlog when you hit this.

- **No OIDC.** Titanium is Keygen CE-based, not an OIDC provider. There is no `/oauth/authorize`, no identity JWT, no refresh tokens. Customer auth is magic-link via the per-app `license-portal`. The architect template's "CRITICAL FINDING" section (`cheeky-watching-crystal-agent-ae8a0df92cc7dafdd.md` top) is the authoritative statement.

- **No Python SDK.** `@titanium/license-client` is TypeScript only. Every non-TS adapter is a hand-written port of the JWKS-verify + blocklist-check slice. Golden-vector test suite shared with the TS upstream is the recommended drift-detection mechanism.

- **`__Host-` cookie prefix mandates.** Must include `Secure`, must include `Path=/`, must NOT include `Domain`. Any framework that auto-injects `Domain=...` will silently fall back to a non-`__Host-` cookie and you'll think it worked. Verify with `curl -v` on first deploy.

- **`maxMachines` on Keygen Policy.** Set to `null` for floating per-user licenses where the user can hit the app from any device. Set to `1` only if you actually want per-machine binding (rare for SaaS — common for desktop).

- **Keygen User `email_verified`.** A Keygen User created via the admin API does NOT automatically have `email_verified=true`. The architect template's email-collision policy (Section 4) treats `email_verified=false` as "no user" — refuse to link until the user verifies in Titanium first.

- **JWKS endpoint shape.** `${TITANIUM_KEYGEN_API_URL}/v1/accounts/${TITANIUM_KEYGEN_ACCOUNT_ID}/.well-known/jwks.json` — note the account ID is in the path, not a query param. Don't hardcode the URL — derive from env.

- **Service token vs admin token.** Runtime uses `TITANIUM_KEYGEN_PORTAL_TOKEN` (product-scoped read). Migration script uses `TITANIUM_KEYGEN_ADMIN_TOKEN` (full admin). Never load the admin token in app runtime config — it's a Stage-E-only secret.

---

## 10. Reference implementations (for future cutovers — dive in here)

- **Bun + Hono adapter (this template's home):** `C:\Users\artic\GitHub\remo-code\.planning\phases\07-titanium-auth-cutover\` — full planning artifacts (CONTEXT, RESEARCH, PATTERNS, PLAN A-J). Source files under `hub/src/` per Section 8.1 file map.
- **FastAPI adapter (architect original):** `C:\Users\artic\GitHub\claude-code-cli-gateway\.planning\phases\02-titanium-auth-cutover\` (per `cheeky-watching-crystal.md` + `cheeky-watching-crystal-agent-ae8a0df92cc7dafdd.md`).
- **Next.js / Express / Tauri adapters:** to be authored as those apps cut over. When you build the first one, fill in Section 8.2 / 8.3 / 8.5 with the real file map and references back to the source repo.
- **Architect templates:** `C:\Users\artic\.claude\plans\cheeky-watching-crystal.md`, `C:\Users\artic\.claude\plans\cheeky-watching-crystal-agent-ae8a0df92cc7dafdd.md`.

---

## 11. How to use this template

1. Read Sections 2 (pre-flight) and 3 (the 10 stages) in full before opening the cutover branch.
2. Pick your stack adapter from Section 8; clone the file map into the target repo's planning dir.
3. Walk A → J. One commit per stage. Run the 16-row matrix on staging before D0. Soak 14 days. Phase X.5 a release later to drop `password_hash` + `bcrypt`.

*End of template. Future portfolio cutovers reuse this verbatim.*
