# Auth model

> **Current (2026-10): Titanium hosted login.** The hub's own HS256 magic link and the
> bcrypt password login are LEGACY rollbacks, off by default. Sections below "Phase 07
> (legacy)" describe them for the rollback window only.

## Titanium hosted login (current)

Canonical consumer contract: titanium-licensing `docs/consumer-integration/README.md`
§3.3 (exchange), §3.3.1 (login CSRF), §3.3.2 (logout), `bun-hono.md`, `tauri.md`.
Code: `hub/src/api/titanium-auth.ts` (routes, mounted at `/auth`, root, NOT under `/api`),
`hub/src/auth/titanium-login.ts` (portal calls, pending cookies), `hub/src/auth/purpose-tokens.ts`
(HKDF keys), `hub/src/db/titanium-link-dal.ts` (user linking). Titanium app slug: `remo-code`.

| Route | What it does |
|---|---|
| `POST /auth/email` | SPA email form, JSON `{email, client?}`. **Origin must equal `REMO_PUBLIC_URL`** (missing or foreign → 403). Sets `remo_login` (signed, 15 min, `{state}`; the app shell also gets a PKCE verifier) and, AFTER the response, asks the portal (`POST https://license.titaniumlabs.us/api/auth/send-magic-link {email, appId:"remo-code", returnUrl}`) to mail a link. Identical `{ok:true}` for every address and for a rate-limited request (3/min/IP, 5/h/address, silent). |
| `POST /auth/start` | "Continue with Titanium" (form). Same Origin rule. `remo_login {state, verifier}` → 303 `https://auth.titaniumlabs.us/login?app_id=remo-code&return_url=<REMO_PUBLIC_URL>/auth/callback?state=…&code_challenge=…&code_challenge_method=S256` (passkey first, email link, Google per the app's portal policy). |
| `GET /auth/callback?state&act` | `state` matches `remo_login` (constant time): `POST /api/exchange {act, app_slug:"remo-code", code_verifier?}` → link user → session. **No match** (link opened on another device, or a link someone handed you): exchange, park the identity in `remo_confirm` (signed, 5 min, own key, csrf; email + accountId only, never the license key) and 303 `/auth/confirm`. **No match and the URL carries `code_challenge`** (a hosted, PKCE-bound login: only the starting browser holds the verifier): the exchange is NOT called (it could only fail and would spend the act); a plain 400 page says "Finish signing in in the browser where you started, or start again", nothing minted, no cookie touched. Nothing is minted on a GET without a state match. |
| `GET /auth/confirm` / `POST /auth/confirm` | "Sign in as a\*\*\*@x.com?" page. The POST mints only with Origin == `REMO_PUBLIC_URL`, a valid `remo_confirm`, and the matching csrf field. Cancel keeps any existing session. |
| `POST /auth/app-finalize` | Tauri shell deep-link leg (see "App shell" below). |
| `POST /auth/logout` | Clears the hub session, CSRF and pending cookies (a missing Origin is accepted, a foreign one refused) → 303 `/auth/signed-out`, which auto-submits a top-level POST to `https://auth.titaniumlabs.us/api/auth/logout` with `return_url=<REMO_PUBLIC_URL>/#/login?signed_out=1`, so the portal's own 7-day session ends too. |

**Exchange checks (fail closed).** Non-2xx or non-JSON → `exchange_failed`; `appSlug` missing
or not `remo-code` → `wrong_app`; empty email → refused. The email is trimmed + lowercased.
`accountId` (optional) is carried into linking. `licenseKey` is ignored here (see "License").

**Keys.** One key per purpose, `HKDF-SHA256(SESSION_SECRET, "remo-code/session-secret/v1",
"remo-code:<purpose>", 32)` for `pending-login` and `pending-confirm`; verify pins HS256 and the
`purpose` claim. `SESSION_SECRET` unset or < 32 chars → the start routes refuse
(`/#/login?error=server_misconfigured`), never a fallback key. The dashboard session itself is
unchanged: opaque `remo_…` token, sha-256 in `auth_sessions`, `__Host-remo_sid` (see below).
Any mint failure is the normal error redirect, never an unhandled 500. A fresh login revokes the
inbound session row first (the step-up gate keys on `auth_sessions.created_at`).

**Pending cookies.** `remo_login` / `remo_confirm`: HttpOnly, Secure (unless `REMO_PUBLIC_URL`
is plain http), SameSite=Lax, `Path=/auth`.

**CSP.** `form-action 'self' https://auth.titaniumlabs.us` (browsers apply form-action to the
303 after `POST /auth/start` and to the logout POST).

### User linking (`linkTitaniumLogin`)

One transaction under an advisory lock:
1. `users.titanium_account_id = accountId` (column added in `schema.sql`, nullable, UNIQUE where not null) → that user.
2. Else `lower(btrim(users.email)) = <verified email>`. Two rows for one normalized email → `account_ambiguous` (refused). One row: attach the accountId on first sight; a row that already carries a **different** accountId → `account_conflict` (refused, never overwritten).
3. Else no user: **no self-signup.** The only creation path is the first-user bootstrap — the users table is EMPTY and the verified email equals `REMO_BOOTSTRAP_ADMIN_EMAIL` → that user is created as `admin` with no password. Otherwise `no_account`. Further users are added by an operator (a `users` row with the email; the first Titanium login attaches the accountId).

No backfill is needed: existing users are linked by email on their first Titanium login.
`hub/scripts/migrate-users-to-titanium.ts` (Keygen `titanium_subject`) is unrelated and unchanged.

### App shell (Tauri, `remo-code://` deep link)

`tauri.md`: PKCE + `app_slug` are mandatory, because a custom-scheme return is owned by no
registered app. The SPA detects the shell (`?remo_shell=` marker set by `mobile/tauri/ui/src/main.ts`,
kept in sessionStorage) and sends `POST /auth/email {client:"app"}`: `remo_login` then holds
`{state, verifier, client:"app"}` in the WebView's cookie jar and the return URL is
`remo-code://auth/callback?state=…&code_challenge=…&code_challenge_method=S256`. The shell
(`mobile/tauri/src-tauri/src/lib.rs`) POSTs `{state, act}` to `/auth/app-finalize` from that WebView;
the hub requires Origin == `REMO_PUBLIC_URL` or one of the exact Tauri WebView origins
(`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`; `MOBILE_TAURI_ORIGINS_ENABLED`,
admitted on `/auth/email {client:"app"}` and `/auth/app-finalize` only, with CORS + credentials for those
origins only and a `SameSite=None; Secure; Partitioned` `remo_login` when the request came from one; a
missing Origin is still refused), a `client:"app"` pending cookie with a verifier and a
state match, then exchanges with the verifier. A deep link this device did not start is refused
(401, no confirmation fallback). The hosted-login button is hidden in the shell (the WebView would
have to hand off to the system browser; not wired). The old `finalize-mobile` handoff is NOT kept as
the live path: it bound nothing to the device that started the login (any minted
`remo-code://…?token=` link signed the receiving app in), so it now sits behind
`LEGACY_MAGIC_LINK_LOGIN`.

### Flags

| Env | Default | Effect |
|---|---|---|
| `REMO_PUBLIC_URL` | `https://app.remo-code.com` | Origin of the hub: callback return URL and the required `Origin` of every state-setting POST. Never the Host header. |
| `REMO_BOOTSTRAP_ADMIN_EMAIL` | unset | First-user bootstrap (empty users table only). |
| `ALLOW_LEGACY_LOGIN` | **`false`** (was `true`) | `true` re-enables bcrypt `POST /api/auth/login` + `/register`, `POST /api/setup/create-admin` and the legacy Bearer JWT (REST + `/ws/client`). Off = those routes 404 and Bearer JWTs are refused. |
| `LEGACY_MAGIC_LINK_LOGIN` | off | `on` re-enables the own magic link (`/api/auth/login/request-link`, `/login/callback`, `/finalize-mobile`). Off = 404. |
| `TITANIUM_BYPASS` | `false` | **License switch only**: skips the Keygen JWKS warm and the license gate. It does not touch login: the hosted login keeps working, and bypass never turns password login on (that needs `ALLOW_LEGACY_LOGIN=true`, explicitly). It still 503s the legacy own magic link when that is enabled. |

`GET /api/client-config` returns `legacy_password_login` / `legacy_magic_link_login` so the
login page shows those forms only while enabled.

### License (unchanged in this release, follow-up)

The license gate still uses the Keygen JWKS/JWT mirror and `SISMEMBER titanium:blocklist`
(`hub/src/titanium-client.ts`). Canonical is the offline Ed25519 license-key validation with the
`blocklist:license:<id>` key (titanium-licensing README §4). Not changed here.

---

# Phase 07 (legacy) — own magic link + bcrypt


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

### Orchestrator key mint — machine path is exempt from step-up (orchestrator-autolaunch, 2026-05-28)

The orchestrator full-power hub API key (capabilities `['agent','supervisor','orchestrator']`, `purpose='orchestrator'`) is minted by two paths:

- **Interactive** `POST /api/orchestrator/start` and `PUT /api/orchestrator` — KEEP `requireRecentAuth()` (15-min step-up) + active license + per-user mutation rate-limit. Enabling the feature is the consent that authorizes future auto-mints.
- **Machine-triggered auto-launch** on `supervisor.hello` (`hub/src/orchestrator/auto-launch.ts` → `launchOrchestrator`) — mints the key WITHOUT step-up, **gated solely on the persisted `users.orchestrator_enabled && !users.orchestrator_disabled_explicitly` flag**.

**Why the machine path is safe without step-up.** A valid supervisor `api_keys` connection over `/ws/agent` already receives `session.start` and spawns arbitrary FS-access Claude processes on the host. The orchestrator key only lets a process the supervisor already spawned call the hub REST API as that user — no capability the supervisor connection didn't already imply. The one thing step-up genuinely protects is *enabling* the feature for a user who turned it off; that stays behind the interactive cookie+step-up `PUT`, and the auto-mint is gated on the resulting persisted flag. So: stolen supervisor key + feature enabled = orchestrator launches (no new power); stolen supervisor key + feature disabled = nothing. The raw key is never echoed over WS/HTTP — it goes ONLY into the `session.start.orchestrator.hub_api_key` field (the spawned process env).

**Cross-supervisor serialization.** Two distinct supervisors helloing for the same user in the race window are serialized by a per-user `pg_advisory_xact_lock(hashtext('orchestrator:'||userId))` held across the whole find-or-create → open-run re-check → reserve → createRun → mint transaction. After the lock, if an open orchestrator run already exists the loser no-ops — exactly one full-power key + one run + one process per user. (`idx_sessions_orchestrator_unique` only guards the session row; `reserveSessionSlot`'s `FOR UPDATE` is per-supervisor and does not serialize across hosts.) Single-host users hit the lock uncontended.

**Sentinel invariant (operational).** NEVER set `users.orchestrator_enabled = false` without also setting `users.orchestrator_disabled_explicitly = true`. `schema.sql`'s on-boot backfill re-enables any non-sentinel user with `orchestrator_enabled = false`, so a bare disable is undone on the next deploy. The interactive `PUT` disable path sets both; any manual/admin disable must too.

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

## API keys — named, scoped, multi (milestone SKEY)

`api_keys` is no longer one-key-per-user. A user may hold N active keys; each key is
**named** and **scoped**.

### Scope matrix

| Scope | Grants | Surface |
|---|---|---|
| `agent` | Authenticate a Supervisor / agent socket → **spawn CLI processes on that host** | `/ws/agent` (both roles), `/api/plugin/*` |
| `ext:read` | Read sessions / transcripts / state | `/api/ext/*` (milestone ASK) |
| `ext:ask` | Ask a session a question (spends tokens) | `POST /api/ext/sessions/:id/ask` |
| `settings:read` | Read settings (**explicit-only**) | GET on the settings allowlist below |
| `settings:write` | Change settings; implies `settings:read` (**explicit-only**) | the settings allowlist below |
| *(NULL / empty)* | **Legacy full access — all scopes** | everything above |

### Settings via API key (`settings:read` / `settings:write`)

`authMiddleware` accepts `Authorization: Bearer remokey_…` on the normal `/api/*` routes,
but ONLY for routes in `SETTINGS_ROUTES` (`hub/src/auth/settings-api-key.ts`) and ONLY
for a key whose scopes EXPLICITLY list `settings:read`/`settings:write` (a legacy NULL key
gets nothing). Any other path → 403 `api_key_not_allowed`; wrong scope → 403
`insufficient_scope`. Allowlist: `/api/profile` (GET/PATCH), `PATCH /api/users/me/profile`,
`PATCH /api/users/me/preferred-supervisor`, `GET /api/usage/summary`, `GET /api/account/usage`,
`/api/account/claude-thresholds` (GET/PUT), `PUT /api/account/revanote-budget-pct`,
`/api/account/notify-channels` (GET/PATCH), `PATCH /api/account/coolify-auto-triage`,
`/api/account/coolify-webhook-allowed-ips` (GET/PUT), `GET /api/supervisors`,
`PATCH /api/supervisors/:id/roots`, `/api/orchestrator` (GET/PUT),
`PATCH /api/sessions/:id/auto-nudge`. Deliberately OUT: `/api/api-keys` (an api key must
never mint one), webhook secrets, `/api/users/me/prompts`, skip-permissions, admin.
`requireRecentAuth` passes an allowlisted settings request from such a key (the key was
minted behind the same step-up). CSRF is skipped by the existing Bearer bypass.
Guarded by `hub/test/settings-api-key.test.ts`.

**Zero migration.** `api_keys.scopes` is additive and NULLABLE. Every key minted before
this milestone has `scopes IS NULL` and keeps working unchanged, including `/ws/agent`.
`hasScope(null, x) === true` by definition (`hub/src/auth/scopes.ts`).

**Security rationale.** The `agent` scope IS the host-spawn credential. An external
consumer (Claude Desktop scheduled task, a script) must get an `ext:*`-only key so that
a leak cannot spawn processes on a dev machine. A key without `agent` is rejected at
`/ws/agent` (close `4001 missing_agent_scope`) and 403 `insufficient_scope` on
`/api/plugin/*`.

### Routes (cookie-auth ONLY)

| Route | Behavior |
|---|---|
| `GET /api/api-keys` | List active keys: `id, name, purpose, scopes, key_prefix, created_at, last_used_at`. **Never** returns key material. |
| `POST /api/api-keys` | Mint. Body `{ name?, scopes?, host? }`. Returns the plaintext **once** (`key`). `scopes` omitted/null ⇒ legacy full-access key. `host: true` (requires `agent`, else 400) ⇒ an additional host key, `purpose='host'`. |
| `POST /api/api-keys/:id/rotate` | Rotate one key in place: same name/scopes/purpose, new secret, old revoked. |
| `DELETE /api/api-keys/:id` | Revoke exactly ONE key (owner-scoped). |

**An api key can never mint an api key.** This router sits behind the session-cookie
catch-all and is never mounted behind `apiKeyMiddleware` — otherwise an `ext:*` key could
mint itself an `agent` key. Guarded by `hub/test/api-keys-scopes.test.ts`.

**Non-browser mint / rotate (operator only).** Because the HTTP surface is deliberately
cookie-only, the headless path is a one-shot script on the hub host (needs `DATABASE_URL`):
`bun run hub/scripts/rotate-api-key.ts rotate --user <email> --key-id <id>` (or `--prefix`),
`… mint --user <email> (--scopes … | --legacy-full-access) [--name …] [--host]`, `… list --user <email>`. It uses the
same DAL/hash helpers as the router and writes the same `token_create` audit event. The
in-process hot-swap does **not** run from the CLI — install the printed key on the affected host.

### Purpose / uniqueness

`purpose` stays at-most-one-active-per-user for `supervisor` (the key carrying `agent` /
legacy NULL scopes) and `orchestrator` (partial unique indexes). Keys minted with
`ext:*`-only scopes get `purpose='external'` and are unconstrained in number — that is
what makes N keys possible. `host: true` agent keys get `purpose='host'` — also unconstrained,
for a second host such as a Claude Code cloud session ([cloud-session-supervisor.md](cloud-session-supervisor.md)).
Hot-swap via `pushKeyRotatedToUser` is TARGETED (`onlyApiKeyIds`): a new `supervisor` mint reaches
only the socket on the prior supervisor key; a `supervisor`/`host` rotate reaches only the host
that held that key. Two hosts must never share a key — they evict each other (`4003 replaced`).

Only the SHA-256 hash is stored. `key_prefix` (first 14 chars of the plaintext) is
captured at mint time for display; legacy rows have `key_prefix IS NULL` (UI shows `—`).

UI: Settings → **Credentials** → API keys table (create with scope checkboxes, rotate,
revoke; the plaintext is shown once with an explicit "you will not see this again").

---

## Related docs

- [README.md](../README.md) — quick-start including magic-link login example
- [docs/scheduled-tasks.md](scheduled-tasks.md) — scheduled-task dispatch (license-gated)
- [docs/error-capture.md](error-capture.md) — error-capture intake (NOT license-gated)
- [docs/grid-view.md](grid-view.md) — multichat grid (license-gated)
- [docs/codex-and-rootless.md](codex-and-rootless.md) — Codex runner + rootless sessions
- [docs/coolify-webhook-migration.md](coolify-webhook-migration.md) — Coolify webhook ingress (pattern shared with Titanium webhook)
- Global rules: [`C:\Users\artic\.claude\CLAUDE.md`](file:///C:/Users/artic/.claude/CLAUDE.md) rules #16, #17, #18 — Titanium Licensing as the auth/billing default, Postgres on Coolify as the DB default, Supabase deprecation
