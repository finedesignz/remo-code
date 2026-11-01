# Auth model

> **Current (2026-10-25): Titanium hosted login is the ONLY login.** The user signs in on the
> Titanium Labs page (`auth.titaniumlabs.us`) and returns to `/auth/callback`; the portal sends
> any sign-in email, branded by `app_id=remo-code`. The hub has NO in-app login form, NO password,
> NO own magic link, NO Bearer-JWT login and NO server-side call to the portal's
> `send-magic-link`. Removed in this change: `POST /api/auth/login`, `/register`,
> `/login/request-link`, `/login/callback`, `/finalize-mobile`, `POST /auth/email`,
> `/api/setup/*`, `ALLOW_LEGACY_LOGIN`, `LEGACY_MAGIC_LINK_LOGIN`, `MAGIC_LINK_SECRET`,
> `hub/scripts/migrate-users-to-titanium.ts`. The `users.password_hash` column and the
> `auth_handoff_tokens` table stay in the schema, inert (never dropped).
> Session cookie, CSRF, and the license gate (`hub/src/license-gate.ts`) are described in code comments
> and `CLAUDE.md`; the pre-2026-10 Phase 07 narrative was removed (see git history).

## Titanium hosted login (current)

Canonical consumer contract: titanium-licensing `docs/consumer-integration/README.md`
§3.3 (exchange), §3.3.1 (login CSRF), §3.3.2 (logout), `bun-hono.md`, `tauri.md`.
Code: `hub/src/api/titanium-auth.ts` (routes, mounted at `/auth`, root, NOT under `/api`),
`hub/src/auth/titanium-login.ts` (portal calls, pending cookies), `hub/src/auth/purpose-tokens.ts`
(HKDF keys), `hub/src/db/titanium-link-dal.ts` (user linking). Titanium app slug: `remo-code`.

| Route | What it does |
|---|---|
| `POST /auth/start` | The only login entry: the "Sign in with Titanium Labs" button (form). **Origin must equal `REMO_PUBLIC_URL`** (missing or foreign → 403/redirect error). App shell: JSON `{client:"app"}` from the exact Tauri WebView origin answers `{url}` (see "App shell"). Same Origin rule. `remo_login {state, verifier}` → 303 `https://auth.titaniumlabs.us/login?app_id=remo-code&return_url=<REMO_PUBLIC_URL>/auth/callback?state=…&code_challenge=…&code_challenge_method=S256` (passkey first, email link, Google per the app's portal policy). |
| `GET /auth/callback?state&act` | `state` matches `remo_login` (constant time): `POST /api/exchange {act, app_slug:"remo-code", code_verifier?}` → link user → session. **No match** (link opened on another device, or a link someone handed you): exchange, park the identity in `remo_confirm` (signed, 5 min, own key, csrf; email + accountId only, never the license key) and 303 `/auth/confirm`. **No match and the URL carries `code_challenge`** (a hosted, PKCE-bound login: only the starting browser holds the verifier): the exchange is NOT called (it could only fail and would spend the act); a plain 400 page says "Finish signing in in the browser where you started, or start again", nothing minted, no cookie touched. Nothing is minted on a GET without a state match. |
| `GET /auth/confirm` / `POST /auth/confirm` | "Sign in as a\*\*\*@x.com?" page. The POST mints only with Origin == `REMO_PUBLIC_URL`, a valid `remo_confirm`, and the matching csrf field. Cancel keeps any existing session. |
| `POST /auth/app-finalize` | Tauri shell deep-link leg (see "App shell" below). |
| `POST /auth/logout` | Clears the hub session, CSRF and pending cookies (a missing Origin is accepted, a foreign one refused) → 303 (a top-level GET, no page or script) to `https://auth.titaniumlabs.us/api/auth/logout?return_url=<encoded REMO_PUBLIC_URL/#/login?signed_out=1>`, so the portal's own 7-day session ends too (a cross-site POST would carry no SameSite=Lax portal cookies). `GET /auth/signed-out` (old links) is a plain 303 to the SPA login: it touches no cookie and never hops to Titanium (no logout CSRF). |

**Exchange checks (fail closed).** Non-2xx or non-JSON → `exchange_failed`; `appSlug` missing
or not `remo-code` → `wrong_app`; empty email → refused. The email is trimmed + lowercased.
`accountId` (optional) is carried into linking. `licenseKey` is ignored here (see "License").

**Keys.** One key per purpose, `HKDF-SHA256(SESSION_SECRET, "remo-code/session-secret/v1",
"remo-code:<purpose>", 32)` for `pending-login` and `pending-confirm`; verify pins HS256 and the
`purpose` claim. `SESSION_SECRET` unset or < 32 chars → the start routes refuse
(`/#/login?error=server_misconfigured`), never a fallback key. The dashboard session itself is
unchanged: opaque `remo_…` token, sha-256 in `auth_sessions`, `__Host-remo_sid` (see below).
Any mint failure is the normal error redirect, never an unhandled 500. No logout CSRF: a failed
login (exchange, linking refusal, session-create error) on the callback, `/auth/confirm` or
`/auth/app-finalize` leaves the inbound session cookie and row untouched; a successful login
revokes the inbound session row only AFTER the new one exists (the step-up gate keys on
`auth_sessions.created_at`).

**Pending cookies.** `remo_login` / `remo_confirm`: HttpOnly, Secure (unless `REMO_PUBLIC_URL`
is plain http), SameSite=Lax, `Path=/auth`.

**CSP.** `form-action 'self' https://auth.titaniumlabs.us` (browsers apply form-action to the
303 after `POST /auth/start` and to the 303 after the SPA's `POST /auth/logout`).

### User linking (`linkTitaniumLogin`)

One transaction under an advisory lock:
1. `users.titanium_account_id = accountId` (column added in `schema.sql`, nullable, UNIQUE where not null) → that user.
2. Else `lower(btrim(users.email)) = <verified email>`. Two rows for one normalized email → `account_ambiguous` (refused). One row: attach the accountId on first sight; a row that already carries a **different** accountId → `account_conflict` (refused, never overwritten).
3. Else no user: **no self-signup.** The only creation path is the first-user bootstrap — the users table is EMPTY and the verified email equals `REMO_BOOTSTRAP_ADMIN_EMAIL` → that user is created as `admin` with no password. Otherwise `no_account`. Further users are added by an operator (a `users` row with the email; the first Titanium login attaches the accountId).

No backfill is needed: existing users are linked by email on their first Titanium login.

### App shell (Tauri, `remo-code://` deep link)

`tauri.md`: PKCE + `app_slug` are mandatory, because a custom-scheme return is owned by no
registered app. The SPA detects the shell (`?remo_shell=` marker set by `mobile/tauri/ui/src/main.ts`,
kept in sessionStorage) and the login button calls `POST /auth/start {client:"app"}` (answers the hosted-login URL, the WebView navigates to it): `remo_login` then holds
`{state, verifier, client:"app"}` in the WebView's cookie jar and the return URL is
`remo-code://auth/callback?state=…&code_challenge=…&code_challenge_method=S256`. The shell
(`mobile/tauri/src-tauri/src/lib.rs`) POSTs `{state, act}` to `/auth/app-finalize` from that WebView;
the hub requires Origin == `REMO_PUBLIC_URL` or one of the exact Tauri WebView origins
(`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`; `MOBILE_TAURI_ORIGINS_ENABLED`,
admitted on `/auth/start {client:"app"}` and `/auth/app-finalize` only, with CORS + credentials for those
origins only and a `SameSite=None; Secure; Partitioned` `remo_login` when the request came from one; a
missing Origin is still refused), a `client:"app"` pending cookie with a verifier and a
state match, then exchanges with the verifier. A deep link this device did not start is refused
(401, no confirmation fallback). The old `finalize-mobile` handoff was removed (it bound nothing to the device that started the login).

### Flags

| Env | Default | Effect |
|---|---|---|
| `REMO_PUBLIC_URL` | `https://app.remo-code.com` | Origin of the hub: callback return URL and the required `Origin` of every state-setting POST. Never the Host header. |
| `REMO_BOOTSTRAP_ADMIN_EMAIL` | unset | First-user bootstrap (empty users table only). |
| `TITANIUM_BYPASS` | `false` | **License switch only**: skips the Keygen JWKS warm and the license gate. It does not touch login: the hosted login keeps working. |

### License (unchanged in this release, follow-up)

The license gate still uses the Keygen JWKS/JWT mirror and `SISMEMBER titanium:blocklist`
(`hub/src/titanium-client.ts`). Canonical is the offline Ed25519 license-key validation with the
`blocklist:license:<id>` key (titanium-licensing README §4). Not changed here.
