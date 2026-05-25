# Phase 07: Titanium Licensing Auth Cutover — Context

**Gathered:** 2026-05-25
**Status:** Ready for planning
**Source:** Architect-reviewed + user-confirmed decisions + aligned to portfolio architect template at `~/.claude/plans/cheeky-watching-crystal.md` (claude-code-cli-gateway Phase 02). All future auth cutovers in the portfolio must follow this 10-stage shape — this phase doubles as the canonical Bun/TypeScript adapter and produces `TEMPLATE.md` for cross-app reuse.

<domain>
## Phase Boundary

This phase replaces remo-code's local bcrypt+JWT user login with delegated identity to Titanium Licensing (Keygen CE under the hood) AND turns on license gating for dashboard access + mutating REST/WS operations. Existing users keep working through a 2-week dual-auth window. Existing agent `api_keys` (`/ws/agent`) are out of scope and MUST continue to verify unchanged — that is the load-bearing acceptance criterion for this phase.

The phase ends when (a) Titanium magic-link is the default and only identity path, (b) license gating is enforced on the right surface (see exclusion list), (c) ≥14 days dual-auth soak passed with zero auth-related regressions and zero agent-traffic regressions, AND (d) the legacy `/api/auth/login` route plus `JWT_SECRET`-signed user-token verify code has been removed (kept alive behind `ALLOW_LEGACY_LOGIN=true` flag for one release as the rollback path).

Dropping `users.password_hash`, removing the `ALLOW_LEGACY_LOGIN` flag, and removing bcrypt from `package.json` is a follow-up phase (Phase 07.5), NOT this one.

</domain>

<decisions>
## Implementation Decisions (LOCKED)

### Identity model: magic-link, NOT OIDC

Titanium Licensing is **Keygen CE-based**, not an OIDC provider. There is no `/oauth/authorize`, no identity JWT, no refresh tokens. Customer auth in Titanium's own `license-portal` is magic-link (15-min HS256 JWT → 7d `lp_session` httpOnly cookie). remo-code's login flow mirrors that exactly — implemented locally in the hub (NOT a redirect to license-portal), with the hub calling Titanium's admin API to look up / create the Keygen User and sending the magic-link email through emails4agents.

### Token format & verification (license JWT)

- License JWTs from Titanium are **EdDSA (Ed25519)** signed. Pinned. Never accept `alg: none`, `alg: HS*`, `alg: RS*`, `alg: ES*` on a token claiming to be from Titanium. Never `verify: false`.
- Hub verifies JWTs locally via JWKS from `${TITANIUM_KEYGEN_API_URL}/v1/accounts/${TITANIUM_ACCOUNT_ID}/.well-known/jwks.json`.
- JWKS cached in-memory; re-fetch on `kid` miss (single-flight, no stampede). Warm-cache during hub `bootstrap()` BEFORE port bind.
- Claims verified every token: `iss == TITANIUM_KEYGEN_API_URL`, `aud` includes `TITANIUM_PRODUCT_ID`, `exp`, `nbf`, `iat` (±30s skew), signature against `kid`-matched key.
- Revocation: Redis blocklist (`titanium:blocklist` set + `titanium:blocklist:{subject_uuid}` keys) checked alongside signature on every verify. Real-time. Hub holds the Redis client.
- Per-request verify is local-only + cheap. No Titanium round-trip on the hot path.

### Dashboard session: server-side opaque, NOT the license JWT

The Titanium license JWT validates *licensing* — it is NOT the dashboard session token. Dashboard session is a server-side opaque session, stored in a new `sessions` table, identified by a cookie. This decouples session revocation from token expiry, lets us revoke instantly, and means a stolen license JWT does not grant dashboard access on its own.

- Cookie name: **`__Host-remo_sid`** (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain).
- Idle timeout: 60 minutes. Absolute timeout: 7 days. Both enforced server-side.
- Magic-link callback issues the session cookie AND records the link to `titanium_subject` + license state.
- Logout deletes the session row + clears the cookie.
- `SESSION_SECRET` env var replaces `JWT_SECRET` for any HMAC needs (cookie integrity, magic-link signing). `JWT_SECRET` rotates → existing legacy JWTs die at cutover → forced re-login.

### Login flow endpoints

- `POST /api/auth/login/request-link` — body `{ email }`. Always returns 200 (login-enumeration prevention) with equal-time response. Generates a magic-link JWT (HS256 signed with `MAGIC_LINK_SECRET`, 15-min TTL, single-use `jti`), stores `jti` reservation, emails the link via emails4agents.
- `GET /api/auth/login/callback?token=...` — verifies the magic-link JWT, marks `jti` used (Redis `magic_link:used:{jti}` EX 900), looks up the Keygen User by email via Titanium admin API, applies the email-collision policy (see below), creates the `sessions` row, sets `__Host-remo_sid`, redirects to dashboard.
- `POST /api/auth/logout` — deletes session row, clears cookie.
- During soak: `POST /api/auth/login` (legacy bcrypt) stays alive behind `ALLOW_LEGACY_LOGIN=true` (default `true` during soak, `false` post-cutover).

### Email-collision policy (mapping job + callback) — VERBATIM CARRYOVER

Magic-link login IS email verification — the migration leans into it. New columns on `users`:

- `titanium_subject TEXT UNIQUE NULL` (was `titanium_user_id` in the draft — renamed to match architect template)
- `titanium_email TEXT NULL`
- `titanium_link_status TEXT NULL` — one of `linked` | `pending_verify` | `mismatch`
- `candidate_subject TEXT NULL`
- `last_titanium_sync_at TIMESTAMPTZ NULL`
- `license_status TEXT NULL`
- `license_id TEXT NULL`
- `license_checked_at TIMESTAMPTZ NULL`

Mapping-job semantics (Stage E):

| Titanium state at migration time | Action |
|---|---|
| No Keygen User with this email | Create Keygen User; set `titanium_subject`; `titanium_link_status='linked'`; send welcome magic-link. |
| Keygen User exists (any license state) | DO NOT auto-link. Set `candidate_subject = keygen.id`; `titanium_link_status='pending_verify'`; send verify magic-link. On first successful callback, promote `candidate_subject` → `titanium_subject`, status=`linked`. |
| Keygen User exists, `email_verified=false` in Keygen | Treat as "no user" — refuse to link; surface in migration-log; require the user to verify in Titanium first. |

Callback pseudocode (TypeScript port of the Python original):

```ts
// inside GET /api/auth/login/callback
if (localRow.titanium_link_status === 'pending_verify') {
  if (localRow.candidate_subject === magicLinkKeygenUserId) {
    await promoteToLinked(localRow); // titanium_subject := candidate_subject; status := 'linked'
  } else {
    await logAuthEvent('link_mismatch', { user_id: localRow.id });
    return c.json({ error: 'link_mismatch' }, 409);
  }
}
```

This policy is load-bearing for every consuming app and goes into `TEMPLATE.md` verbatim.

### Audit log: `auth_events` (in scope this phase)

NOT deferred. Columns: `id BIGSERIAL`, `user_id UUID NULL` (NULL for failed lookups), `event_type TEXT` (one of: `login_request`, `login_success`, `login_failed`, `logout`, `link_success`, `link_mismatch`, `license_check_failed`, `token_create`, `token_rotate`), `ip TEXT`, `user_agent TEXT`, `ts TIMESTAMPTZ DEFAULT now()`, `metadata JSONB`. Indexed on `(user_id, ts DESC)` and `(event_type, ts DESC)`. Every endpoint in stages C, D, G writes here.

### License gating — ON from D0, single-track (NOT dual-track)

Identity is dual-track during soak. **License gating is single-track from D0** — a bcrypt-logged-in user with no active Titanium license still gets `402 Payment Required` on mutating routes.

New middleware: `hub/src/license-gate.ts`.

**Applied to:**
- All dashboard HTML routes (the SPA index, settings pages).
- All mutating `/api/*` endpoints (session create/delete, scheduled-tasks CRUD, error-projects CRUD, profile updates, etc.).

**NOT applied to (exclusion list — load-bearing):**
- `GET /health` (and `/metrics` if added).
- `/api/sentry/:project_id/envelope/` — public intake, `sentry_key` IS its auth.
- `/ws/agent` — agent traffic, `api_keys` unchanged.
- `/api/coolify/webhook/*` — HMAC-authed.
- `/ws/supervisor` — supervisor connections (no Titanium identity).
- `GET /openapi.json` and `GET /docs` — public Scalar UI.

**License states & behavior:**
- `ACTIVE` → allow.
- `EXPIRED` < 7 days ago → **read-only grace mode**: GET allowed, mutating routes return 402.
- `EXPIRED` ≥ 7 days, `SUSPENDED`, `BANNED`, missing → 402 on everything gated.
- Webhook receiver `POST /webhooks/titanium/license-changed` with HMAC verification — OPTIONAL, ship if Titanium exposes one; otherwise rely on 5-min TTL cache + the real-time Redis blocklist.

**Cache:** in-process 5-min TTL keyed by `titanium_subject`. Blocklist check is always live (no cache).

### CSRF protection — double-submit cookie

New `hub/src/csrf.ts`. On every mutating REST endpoint AND every WS message that mutates server state:

- Server sets `csrf_token` cookie (not HttpOnly, SameSite=Lax) on session creation.
- Client mirrors it back in `X-CSRF-Token` header on REST OR in the WS message body (`{ ..., csrf_token: "..." }`).
- Server constant-time compares. Mismatch → 403.
- Exempt: GETs, the exclusion list above, agent WS traffic (`/ws/agent`).

### Re-auth gate (<5 min session age)

Mutating operations of elevated impact require the session to be <5 minutes old. If older, return 401 with `error: 're_auth_required'` and the client triggers a fresh magic-link round-trip. Applied to:

- Token create / rotate (any `api_keys` mutation by the user).
- Scheduled-task `delete-all` bulk op.
- Error-project secret rotation (`sentry_key` rotate).
- User account changes (email, role if self-editable).
- Logout-all-other-sessions (if implemented).

### Security headers middleware

Extend existing Hono middleware (or add `hub/src/security-headers.ts` if absent). Set:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (2yr + preload).
- `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://app.remo-code.com ${TITANIUM_KEYGEN_API_URL}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` — adjusted to match the React SPA's actual needs (planner audits and tightens).
- `Cross-Origin-Opener-Policy: same-origin`.
- `Cross-Origin-Resource-Policy: same-origin`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `X-Content-Type-Options: nosniff`.
- `X-Frame-Options: DENY`.
- Strip `Server` header.

### Rate limits

Extend existing rate-limit infra (`hub/src/rate-limit/` if present; else add minimal token-bucket impl). Limits:

- `POST /api/auth/login/request-link` → **3 / min / IP** AND **5 / hr / email**.
- `GET /api/auth/login/callback` → **10 / min / IP**.
- Token-mutating endpoints (scheduled-tasks create, error-projects create, api_keys create/rotate, etc.) → **10 / min / user**.
- Login-enumeration prevention: request-link ALWAYS returns 200, ALWAYS within equal-time window (planner picks ±50ms), regardless of whether email exists.

### Magic-link single-use enforcement

On first successful callback: write `magic_link:used:{jti}` to Redis with `EX 900` (15 min, matches TTL). On any subsequent callback with same `jti`: reject with 409 even if signature + TTL still valid. Prevents replay if the link is leaked/intercepted.

### Admin "force token reissue" action

When a user is banned/license revoked, an admin action (CLI script or hub endpoint TBD by planner) flips `is_active=false` on ALL `api_keys` rows for that `user_id`. Agent traffic gets disconnected at next heartbeat. This is the rebuttal to "what about long-lived agent tokens for a banned user."

### Cutover sequencing — D0 / D7 / D14 / D14+1

| Day | State |
|---|---|
| **D0** | Magic-link is the default at `/login`. "Use password instead" link still visible (bcrypt path live). Both paths issue the same `__Host-remo_sid` session cookie. Both write to `auth_events`. **License gating active from D0 on BOTH paths.** |
| **D0–D3** | Migration script runs `--apply` in batches (50/batch, 5-min spacing). Operator watches `auth_events` for `login_failed` storms + `link_mismatch` events. |
| **D7** | UI hides the password fallback link (URL still resolves if `ALLOW_LEGACY_LOGIN=true`). Nudge email sent to users who haven't magic-linked yet. |
| **D14** | Legacy `POST /api/auth/login` returns `410 Gone` (or 404 — planner picks). `ALLOW_LEGACY_LOGIN` flag stays present + functional for one release as the rollback path. Phase 07 declared green. |
| **D14+1 (Phase 07.5)** | Drop `password_hash` column, remove `bcrypt` dep, delete `_hashPassword`/`_checkPassword`, remove `ALLOW_LEGACY_LOGIN` flag, finalize `JWT_SECRET` → `SESSION_SECRET` rotation. |

**Important:** dual-auth covers identity only. License gating is single-track from D0 — a bcrypt-logged-in user with no active Titanium license still gets `402` on mutating routes. Titanium-uptime and remo-code-uptime are **decoupled for read, coupled for write** (5-min TTL cache + Redis blocklist absorb short Titanium outages for read ops; writes degrade after the TTL).

### Rollback

- During soak: no rollback needed — both paths live.
- Post-cutover (≤1 release): `ALLOW_LEGACY_LOGIN=true` env flag re-enables the bcrypt path + `/api/auth/login` route. Code stays in the repo behind the flag for one release.
- `password_hash` column stays present (nullable) for the same window so bcrypt rollback is possible. Dropped in Phase 07.5.

### Roles & authorization

- `users.role` stays local to remo-code. Titanium is identity + licensing, not authorization.
- Do NOT push `role` into Titanium claims. Do NOT consume any `role` claim from Titanium tokens.

### Email change after cutover

- On every authenticated request, hub re-reads `email` from the verified Titanium JWT claims. If it differs from `users.email`, update by `titanium_subject`. Handles email change in Titanium without a webhook.
- `users.email UNIQUE` collision on update: log to `auth_events` (`event_type='email_update_conflict'`) + reject the update, keep stale email until manual resolution (rare).

### TS port of `@titanium/license-client` slice

The Python original ported `@titanium/license-client`'s JWKS-verify + blocklist-check slice into `app/titanium_client.py`. For remo-code (TS → TS), the port becomes `hub/src/titanium-client.ts` and is much simpler — same `jose` library both sides, can theoretically share the verify function with the TS source. Planner SHOULD include a golden-vector test suite shared with the upstream TS client to catch clock-skew / kid-rotation / error-taxonomy drift.

### Out of scope (explicit non-goals)

- **Agent `api_keys`** (`/ws/agent`) — unchanged. Zero regression is load-bearing.
- `error_projects.sentry_key` — unchanged (per-project HMAC-style auth on a public endpoint).
- Supervisor auth (`/ws/supervisor`) — unchanged.
- Coolify webhook HMAC (`/api/coolify/webhook/*`) — unchanged.
- GHL webhook auth — unchanged.
- Dropping `password_hash` column — Phase 07.5.
- Removing `bcrypt` dep — Phase 07.5.
- Removing `ALLOW_LEGACY_LOGIN` flag — Phase 07.5.
- Admin impersonation — defer until Titanium exposes `act` claim and it's actually needed.
- Per-app Titanium roles claim — local `users.role` is sufficient.
- Hub-side refresh-token storage — global rule #16 forbids; deferred indefinitely.
- Webhook-on-Titanium-user-update — re-reading email on every request is simpler; revisit only if perf shows it matters.

### Claude's Discretion

- JWKS library: prefer `jose` (zero deps, EdDSA + JWKS native). Confirm before adding.
- Redis client: prefer `ioredis` unless hub already uses `redis`.
- Migration tooling style: match existing schema-change pattern in `hub/src/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).
- Feature-flag implementation: env var read at boot is fine; no flag-management service.
- Mapping job location: `hub/scripts/migrate-users-to-titanium.ts` (renamed from `map-users-to-titanium.ts` to match architect template). `--dry-run` is the DEFAULT mode; `--apply` is opt-in.
- Rate-limit impl: planner audits existing infra first; only add minimal in-process token bucket if nothing reusable.
- Security-headers middleware location: extend existing if present in `hub/src/index.ts` middleware chain; else `hub/src/security-headers.ts`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architect template (the shape EVERY auth cutover in the portfolio follows)
- `C:\Users\artic\.claude\plans\cheeky-watching-crystal.md` — primary template (claude-code-cli-gateway Phase 02, Python/FastAPI). 10-stage shape. Email-collision policy, D0/D7/D14 schedule, license-gating exclusion list, dual-track decoupling rationale.
- `C:\Users\artic\.claude\plans\cheeky-watching-crystal-agent-ae8a0df92cc7dafdd.md` — detailed architect draft. Reference for the verbose pseudocode + risk register.
- This phase produces `TEMPLATE.md` at `.planning/phases/07-titanium-auth-cutover/TEMPLATE.md` — stack-agnostic checklist + per-stack adapters (Bun/Hono, Next.js, Express, FastAPI, Tauri). **This is the user's primary deliverable from this phase.**

### Hub current auth (the thing being replaced)
- `hub/src/db/schema.sql` — current `users`, `api_keys`, `sessions` (if exists), table definitions. Target of the additive migration.
- `hub/src/index.ts` — REST mount order, JWT catch-all location. The public sentry intake (`hub/src/api/sentry-intake.ts`) is mounted OUTSIDE the catch-all — preserve that boundary. License-gate middleware goes INSIDE the catch-all, AFTER auth.
- `hub/src/ws/client.ts` + `hub/src/ws/protocol.ts` — `/ws/client` auth handler. Verify branch + CSRF on mutating WS messages goes here.
- `hub/src/ws/agent.ts` + `hub/src/ws/agent-protocol.ts` — DO NOT TOUCH. Agent traffic stays unchanged.
- Grep for `bcrypt`, `JWT_SECRET`, `jsonwebtoken`, `jose` to locate the current login + verify code paths.
- Any `hub/src/api/auth*.ts` route handlers.

### Web current auth
- `web/src/` — login form, token storage (likely `localStorage.session`), REST attachment, WS auth payload construction. Find and update all three call sites.
- Header / nav layout — the license badge dot goes here.

### Titanium Licensing (the new auth source)
- `C:\Users\artic\GitHub\titanium-licensing` — full repo. Read its `README.md`, `CLAUDE.md`, `docs/`.
- Specifically locate: Keygen CE admin API for user create/lookup, license-key issuance, JWKS endpoint pattern (`/v1/accounts/:id/.well-known/jwks.json`), Redis blocklist write path (so we know what to watch), `services/license-portal/src/lib/auth.ts` (the magic-link reference impl to mirror in TS).
- `@titanium/license-client` (TS package) — JWKS-verify + blocklist-check slice to port. Golden vectors shared.
- license-portal service runs on `:9103` locally; planner should read titanium-licensing config for the prod URL.

### Reused infra inside remo-code
- `emails4agents` (global rule #7) — magic-link delivery uses `POST /v1/messages/send` with `X-API-Key`. Env: `E4A_API_KEY`, `E4A_BASE_URL`, `E4A_INBOX_ID`.
- Existing rate-limit infra (planner audits) — extend, don't replace.
- Existing security-headers middleware in `hub/src/index.ts` chain (planner audits) — extend, don't replace.
- `hub/src/lib/crypto.ts` — for any HMAC/SHA-256 needs (CSRF compare, magic-link signing fallback).
- `hub/src/scheduler/post-run/template.ts` — pattern for templated emails (magic-link email body).

### Project-wide rules
- `C:\Users\artic\.claude\CLAUDE.md` — rule #7 (emails4agents default), rule #11 (Karpathy — smallest diff), rule #16 (Titanium is the auth default + migration nuance), rule #17 (Postgres on Coolify), rule #19 (fresh branch — done), rule #20 (worktrees — done), rule #14 (docs + README updated on completion), rule #21 (`/openapi.json` + `/docs` + `docs/` + `README.md` + `CLAUDE.md`).
- `C:\Users\artic\GitHub\remo-code\CLAUDE.md` — repo conventions, WS protocol shape, env var conventions, deployment notes, scheduler/error-capture/grid-view docs that the cleanup stage must update.

### Migration reference (template)
- `C:\Users\artic\GitHub\effortr\.planning\MIGRATION-PLAN.md` — informational; auth cutover isn't a Supabase migration but the dual-window + rollback shape is the same family.

</canonical_refs>

<specifics>
## Specific Anchors

### New env vars (hub)
- `TITANIUM_KEYGEN_API_URL` — e.g. `https://keygen.titaniumlabs.us`
- `TITANIUM_ACCOUNT_ID` — Keygen account UUID
- `TITANIUM_PRODUCT_ID` — Keygen Product UUID for remo-code (OPEN QUESTION — does it exist yet?)
- `TITANIUM_PORTAL_TOKEN` — service token for license-portal admin calls
- `TITANIUM_ADMIN_TOKEN` — service token for Keygen admin user CRUD (migration only — script-time, NOT runtime)
- `TITANIUM_REDIS_URL` — redis://… for blocklist + magic-link `jti` + license cache + rate-limit buckets
- `TITANIUM_LICENSE_CACHE_TTL_SECONDS` — default `300`
- `MAGIC_LINK_SECRET` — HS256 secret for magic-link JWT signing (rotatable)
- `SESSION_SECRET` — HMAC for `__Host-remo_sid` cookie integrity / CSRF token derivation (replaces `JWT_SECRET` for user auth)
- `ALLOW_LEGACY_LOGIN` — `true|false`, default `true` during soak, `false` post-cutover

### New DB columns (`users` table — additive only)
- `titanium_subject TEXT UNIQUE NULL`
- `titanium_email TEXT NULL`
- `last_titanium_sync_at TIMESTAMPTZ NULL`
- `license_status TEXT NULL`
- `license_id TEXT NULL`
- `license_checked_at TIMESTAMPTZ NULL`
- `titanium_link_status TEXT NULL` — `linked` | `pending_verify` | `mismatch`
- `candidate_subject TEXT NULL`
- `password_hash TEXT NULL` — drop NOT NULL (was previously NOT NULL)

### New tables
- `auth_events(id BIGSERIAL PK, user_id UUID NULL, event_type TEXT, ip TEXT, user_agent TEXT, ts TIMESTAMPTZ DEFAULT now(), metadata JSONB)` — indexes `(user_id, ts DESC)`, `(event_type, ts DESC)`
- `sessions(id TEXT PK, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT now(), last_used_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, ip TEXT, user_agent TEXT)` — indexes `(user_id)`, `(expires_at)`
- `mapping_conflicts` — folded INTO `auth_events` with `event_type='link_mismatch'` to keep the schema lean; planner confirms.

### Dependencies to add (hub)
- `jose` — EdDSA + JWKS verifier. Confirm not already present.
- `ioredis` — Redis client. Confirm not already present.

### Files to create (planner outputs full paths in PLANs)
- `hub/src/titanium-client.ts` — JWKS fetch + EdDSA verify + license-key validate + blocklist check + Keygen User admin slice
- `hub/src/session.ts` — opaque session create/verify/extend/delete + cookie ops
- `hub/src/license-gate.ts` — middleware
- `hub/src/csrf.ts` — double-submit cookie helpers
- `hub/src/security-headers.ts` (if not extending existing) — middleware
- `hub/src/api/auth.ts` (or extend existing) — `request-link` / `callback` / `logout` endpoints
- `hub/src/api/webhooks-titanium.ts` (optional) — `license.changed` receiver
- `hub/scripts/migrate-users-to-titanium.ts` — one-shot mapping job with `--dry-run` default
- `web/src/pages/Login.tsx` (or equivalent) — email-only magic-link form
- `web/src/pages/AuthCallback.tsx` — handles `/auth/callback?token=...` redirect
- `web/src/lib/hubFetch.ts` — extend to attach `X-CSRF-Token` + `credentials: 'include'`
- `.planning/phases/07-titanium-auth-cutover/TEMPLATE.md` — stack-agnostic checklist + adapters (PRIMARY DELIVERABLE)

### Files to modify
- `hub/src/db/schema.sql` — additive migration
- `hub/src/index.ts` — wire new middleware (security-headers, license-gate, csrf, session)
- `hub/src/ws/client.ts` + `hub/src/ws/protocol.ts` — dual-auth verify branch + CSRF on mutating WS messages
- `hub/src/api/_openapi.ts` — document new auth endpoints
- `web/src/App.tsx` (or router) — add `/login` + `/auth/callback` routes
- `package.json` (hub) — add `jose`, `ioredis`
- `README.md`, `CLAUDE.md`, `docs/auth.md` (new) — document Titanium flow
- `hub/test/` — add `titanium-client.test.ts`, `session.test.ts`, `license-gate.test.ts`, `csrf.test.ts`, `auth-events.test.ts`, golden-vector test suite shared with upstream `@titanium/license-client`

### Files NOT to touch (load-bearing)
- `hub/src/ws/agent.ts` + `hub/src/ws/agent-protocol.ts` — agent `api_keys` flow
- `hub/src/api/sentry-intake.ts` — public error-capture intake
- `hub/src/api/coolify-webhook.ts` — HMAC-authed Coolify webhook
- `hub/src/ws/supervisor.ts` (if exists) — supervisor traffic
- Any `error-capture/*.ts` — separate auth model

</specifics>

<deferred>
## Deferred Ideas

- Drop `password_hash` column — Phase 07.5.
- Remove `bcrypt` from `package.json` — Phase 07.5.
- Remove `ALLOW_LEGACY_LOGIN` flag + bcrypt code — Phase 07.5.
- Admin impersonation (`act` claim) — wait for Titanium support + actual need.
- Per-app Titanium roles claim — current local `users.role` suffices.
- Hub-side refresh-token storage — global rule #16 forbids.
- Titanium-emits-webhook-on-user-update — re-reading email on every verified request handles it.
- Move `error_projects.sentry_key` to Titanium — separate consideration; out of scope this phase.
- Move supervisor `api_keys` to Titanium — separate consideration; supervisors aren't end-users.

</deferred>

<open_questions>
## Open Questions (surface to user before execution)

1. **Keygen Product ID for remo-code** — does a `Product` already exist in Titanium's Keygen for remo-code? If not, it must be created before `TITANIUM_PRODUCT_ID` can be set, before the mapping job can run.
2. **License model** — per-user (one Keygen License per remo-code user, recommended) OR per-tenant (Keygen Group)? Per-user matches the current 1:1 users:account model in remo-code.
3. **Webhook availability** — does Titanium ship a `license.changed` webhook today? If YES: get the shared secret + endpoint shape. If NO: ship with 5-min TTL cache + the real-time Redis blocklist; flag in Titanium's backlog; revisit in a follow-up.
4. **Existing rate-limit + security-headers middleware in hub** — planner audits during research; reuse if present, add minimal impl if not. (This is research/discretion, not a user-facing question — confirming so the user knows the planner will handle it.)

</open_questions>

---

*Phase: 07-titanium-auth-cutover*
*Context locked: 2026-05-25 — architect-template-aligned, no discuss-phase*
