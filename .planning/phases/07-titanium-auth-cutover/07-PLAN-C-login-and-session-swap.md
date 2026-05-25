# 07-PLAN-C: Login + session swap (magic-link + opaque sessions)

**Stage:** C
**Wave:** 2 (depends on A + B)
**Mode:** standard
**TDD:** yes
**Requirements:** R-AUTH-04, R-AUTH-08, R-AUTH-09 (partial)

<read_first>
- `07-CONTEXT.md` "Login flow endpoints", "Dashboard session: server-side opaque", "Email-collision policy", "Magic-link single-use", "Re-auth gate"
- `07-RESEARCH.md` §2.3
- `07-PATTERNS.md` rows for `session.ts`, `csrf.ts`, `api/auth.ts` extend
- `hub/src/api/auth.ts` — current login + register
- `hub/src/auth/middleware.ts` — JWT verify
- `hub/src/api/coolify-webhook.ts` — raw-body-before-JSON pattern (for magic-link callback if it ever takes raw body)
- `hub/src/scheduler/post-run/email.ts` — emails4agents send pattern (for magic-link email)
- `services/license-portal/src/lib/auth.ts` in titanium-licensing — reference impl
</read_first>

<tasks>

### C.1 Implement `hub/src/session.ts`
- Exports `createAuthSession`, `verifyAuthSessionCookie(req): Promise<AuthSessionContext | null>`, `extendIfStale(sessionId)`, `deleteAuthSession`.
- Cookie ops: `setSessionCookie(c, sessionId)` → sets `__Host-remo_sid=<id>; HttpOnly; Secure; SameSite=Lax; Path=/`. `clearSessionCookie(c)` → max-age 0.
- `verifyAuthSessionCookie`: reads cookie → DAL `getAuthSessionById` → null if not found / expired. Enforces idle 60m: if `now - last_used_at > 60m`, delete + return null. Enforces absolute 7d: if `now > expires_at`, delete + return null. Otherwise `touchAuthSession(id)`.
- Module-load: `if (config.sessionSecret.length < 32) throw …` (HMAC over cookie body isn't strictly required since the cookie is just an opaque ID — but `SESSION_SECRET` is reused for CSRF derivation; gate it anyway).
<acceptance_criteria>
Unit test in `hub/test/session.test.ts` covers: cookie set/read round-trip, idle expiry, absolute expiry, delete, cookie absence. All green.
</acceptance_criteria>

### C.2 Implement `hub/src/csrf.ts`
- `issueCsrfToken(sessionId): string` — `HMAC-SHA256(SESSION_SECRET, sessionId + ':' + random16)` truncated to 32 hex chars.
- `setCsrfCookie(c, token)` — `csrf_token=<token>; Secure; SameSite=Lax; Path=/` (NOT HttpOnly so JS can read it).
- `verifyCsrf(c): boolean` — reads `X-CSRF-Token` header (or `csrf_token` from JSON body for WS), reads `csrf_token` cookie, constant-time compares.
- Helper Hono middleware `csrfGuard()` for mutating REST: returns 403 on mismatch.
- WS: planner adds `csrf_token` optional field to mutating message types in `hub/src/ws/protocol.ts`; handler in `hub/src/ws/client.ts` verifies.
<acceptance_criteria>
`hub/test/csrf.test.ts` covers: issue/verify round-trip, tampered token rejected, missing cookie rejected, missing header rejected, GET passes through. Green.
</acceptance_criteria>

### C.3 Add login endpoints to `hub/src/api/auth.ts`
- `POST /api/auth/login/request-link`:
  - Body `{ email }`.
  - ALWAYS return `200 { ok: true }` (enumeration prevention).
  - Equal-time response via `await waitUntil(start + 250ms)`.
  - Look up user by email. If exists AND has `titanium_subject` OR `titanium_link_status = 'pending_verify'`: sign magic-link JWT (HS256 `MAGIC_LINK_SECRET`, 15m TTL, fresh `jti`, claims `{ sub: userId, email, jti, purpose: 'magic-link' }`), send email via emails4agents with link `${BASE_URL}/api/auth/login/callback?token=...`.
  - Write `auth_events` row (`event_type='login_request'`, metadata `{ email, sent: boolean }`).
  - Rate limit: 3/min/IP + 5/hr/email (uses PLAN-G rate limiter).
- `GET /api/auth/login/callback?token=...`:
  - Verify magic-link JWT (HS256, `MAGIC_LINK_SECRET`, full claim check).
  - Check `magic_link:used:{jti}` in Redis — if present, 409 `link_reused`. Else `SET EX 900`.
  - Look up `users` row by `sub`. Apply email-collision policy from CONTEXT (callback pseudocode).
  - Look up / create Keygen User via `titanium-client.keygenAdmin.findUserByEmail` / `createUser`.
  - On success: write `auth_events` (`login_success` or `link_success`), create `auth_sessions` row (TTL 7d), `setSessionCookie`, `setCsrfCookie`, redirect to `/`.
  - On collision: write `link_mismatch`, return 409.
  - Rate limit: 10/min/IP.
- `POST /api/auth/logout`:
  - Read cookie. If session found: `deleteAuthSession`. Write `auth_events` (`logout`).
  - Clear cookie + CSRF cookie. Return 200.
<acceptance_criteria>
`hub/test/auth-routes.test.ts` (DB-gated) covers each endpoint: enumeration-200, magic-link expiry, replay rejection, collision 409, happy callback issues cookie, logout clears cookie. Green.
</acceptance_criteria>

### C.4 Magic-link email template
- Add `hub/src/api/auth-email.ts` (or inline) with `renderMagicLinkEmail({ url, email, ttlMinutes })` returning `{ subject, html, text }`.
- Use `emails4agents` API (`POST /v1/messages/send`) with `E4A_API_KEY` + `E4A_INBOX_ID`.
- Subject: `"Sign in to remo-code"`. Body: brief, security-hygiene note ("expires in 15 min, single-use, ignore if you didn't request").
- One template, no theming branch.
<acceptance_criteria>
Unit test renders the email and asserts `subject`, `text` contains the URL, `html` contains the URL. Send is mocked.
</acceptance_criteria>

### C.5 Re-auth gate helper
- `hub/src/auth/reauth.ts` — exports `requireRecentAuth(maxAgeSeconds = 300)` Hono middleware.
- Reads session, checks `now() - session.created_at <= maxAgeSeconds`. Else `401 { error: 're_auth_required' }`.
- Apply to: `POST /api/api-keys`, `POST /api/api-keys/:id/rotate`, `DELETE /api/scheduled-tasks` (bulk), `POST /api/error-projects/:id/rotate-secret`, `PATCH /api/account` (email change). Planner audits and locks the exact list during execution.
<acceptance_criteria>
`hub/test/reauth.test.ts` mocks session timestamps and asserts 401 when stale, pass-through when fresh.
</acceptance_criteria>

### C.6 Dual-auth shim in `hub/src/auth/middleware.ts`
- Refactor `authMiddleware` to accept EITHER a Titanium session cookie OR (during soak, when `ALLOW_LEGACY_LOGIN=true`) a legacy `Authorization: Bearer <jwt>`.
- Order: try cookie first (preferred), fall back to bearer if `ALLOW_LEGACY_LOGIN`.
- Sets the SAME context vars (`c.set('userId' | 'userRole' | 'userEmail')`) regardless of source.
- Records `auth_events.event_type='login_success'` ONLY at session creation time (not per request).
<acceptance_criteria>
`hub/test/auth-middleware.test.ts` covers: valid cookie → pass, no cookie + valid bearer + `ALLOW_LEGACY_LOGIN=true` → pass, no cookie + valid bearer + `ALLOW_LEGACY_LOGIN=false` → 401, no auth at all → 401, expired cookie → 401, tampered bearer → 401. Green.
</acceptance_criteria>

### C.7 WS dual-auth in `hub/src/ws/client.ts`
- Auth message accepts EITHER `{ type: 'auth', token }` (legacy bearer, gated by flag) OR `{ type: 'auth', session_cookie_id }` extracted from upgrade-request `Cookie:` header.
- Preferred: read cookie from upgrade request directly — client sends NO token in the WS payload when authenticated via cookie. The auth message becomes `{ type: 'auth' }` (empty), and the server reads the cookie from the HTTP upgrade.
- Adds `csrf_token` field to mutating WS message types in `hub/src/ws/protocol.ts` Zod schemas. Handlers verify before processing.
<acceptance_criteria>
`hub/test/ws-auth.test.ts` covers: upgrade with valid cookie → connection accepted, upgrade without cookie + flag-on + valid bearer in payload → accepted, mutating message without csrf → rejected. Green.
</acceptance_criteria>

</tasks>

**Outputs:** new `session.ts`, `csrf.ts`, `reauth.ts`, magic-link endpoints, dual-auth REST + WS. Bcrypt path still alive behind flag.

**Verification:** all C.* tests green; manual smoke: dev hub + dev web → magic-link end-to-end logs in (using stub emails4agents → log line).
