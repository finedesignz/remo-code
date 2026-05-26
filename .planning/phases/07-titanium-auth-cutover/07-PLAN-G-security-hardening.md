# 07-PLAN-G: Security hardening (headers, rate limits, audit, anti-replay)

**Stage:** G
**Wave:** 3 (depends on C; parallel with D, E, F)
**Mode:** standard
**TDD:** yes
**Requirements:** R-AUTH-01 (alg pin), R-AUTH-06 (blocklist), R-AUTH-08 (audit), and the rate-limit / CSP / anti-replay decisions in CONTEXT.md

<read_first>
- `07-CONTEXT.md` "Security headers middleware", "Rate limits", "Magic-link single-use enforcement", "JWT verifier hardening"
- `07-PATTERNS.md` row for `middleware/security-headers.ts`
- `hub/src/middleware/rate-limit.ts` — existing infra to extend
- `hub/src/titanium-client.ts` (PLAN-A)
</read_first>

<tasks>

### G.1 `hub/src/middleware/security-headers.ts`
- Hono middleware. Sets headers from CONTEXT.md list (HSTS 2yr+preload, CSP, COOP, CORP, Referrer-Policy, X-Content-Type-Options, X-Frame-Options).
- Strips `Server` response header.
- CSP value: build from a typed object so test can assert each directive without string parsing.
- Mount FIRST in the middleware chain (`hub/src/index.ts`), before everything else.
<acceptance_criteria>
`hub/test/security-headers.test.ts` issues a GET via mock context and asserts every header present + `Server` absent. Manual smoke: `curl -I https://localhost:3040/health` shows headers.
</acceptance_criteria>

### G.2 Extend `hub/src/middleware/rate-limit.ts`
- Audit current shape. If it doesn't support multi-window (3/min/IP + 5/hr/email simultaneously) and Redis-backed keys: extend with:
  - Pluggable backend (memory default, Redis when `TITANIUM_REDIS_URL` set).
  - Multiple keying functions per route (e.g. both IP-and-email).
  - Standard `Retry-After` header on 429.
- Apply limits per CONTEXT.md:
  - `POST /api/auth/login/request-link`: 3/min/IP + 5/hr/email
  - `GET /api/auth/login/callback`: 10/min/IP
  - All "mutating" token endpoints: 10/min/user (use `userId` from context as key)
<acceptance_criteria>
`hub/test/rate-limit.test.ts` covers each window. Hitting limits returns 429 with `Retry-After`. Restart of hub does not reset Redis-backed buckets (key persistence verified).
</acceptance_criteria>

### G.3 Magic-link single-use enforcement
- Already specified in PLAN-C.3 callback. Move the Redis ops here for clarity:
  - On send (`request-link`): NO reservation needed (jti is created server-side).
  - On callback first verify: `SET magic_link:used:{jti} 1 EX 900 NX`. If `NX` fails (key exists), return 409 with `event_type='login_failed', metadata.reason='link_reused'`.
- Document Redis key shape + TTL in `hub/src/api/auth.ts` header comment.
<acceptance_criteria>
Test in `hub/test/auth-routes.test.ts` simulates double-click on magic link: first call 200, second call 409.
</acceptance_criteria>

### G.4 Login-enumeration equal-time response
- `request-link` handler wraps work in `withMinDuration(handler, 250ms)` helper. Helper: `const start = Date.now(); try { await handler(); } finally { const elapsed = Date.now() - start; if (elapsed < min) await sleep(min - elapsed); }`.
- Same handler shape regardless of email-exists vs not-exists. No early-return.
<acceptance_criteria>
Test measures response time over 20 iterations split between known + unknown emails; std-dev < 50ms.
</acceptance_criteria>

### G.5 JWT verifier hardening review
- Cross-check PLAN-A implementation: `algorithms: ['EdDSA']` ONLY, no `'none'`, `verify` always on. Add explicit unit test for each.
- Add test: passing a Titanium-looking JWT signed with HS256 + `alg: HS256` → rejected.
- Add test: passing a JWT with `alg: none` → rejected (jose rejects by default; assert).
<acceptance_criteria>
Three additional golden vectors in `titanium-vectors.json` ALL fail in tests. Green.
</acceptance_criteria>

### G.6 Audit log writes — coverage sweep
- Sweep every endpoint added in stages C, D, E for `recordAuthEvent` calls. Required events:
  - `login_request`, `login_success`, `login_failed`, `logout`
  - `link_success`, `link_mismatch`
  - `license_check_failed` (throttled 1/min/user)
  - `token_create`, `token_rotate` (on `/api/api-keys` endpoints — extend existing handlers; they don't currently audit)
- One assertion per endpoint test: `auth_events` row inserted with expected `event_type` + sensible `metadata`.
<acceptance_criteria>
All endpoints have ≥1 test asserting the audit event. Aggregate test `hub/test/auth-events.test.ts` issues a sequence of login → fail → success → logout and asserts the event timeline matches.
</acceptance_criteria>

### G.7 Admin "force token reissue" action
- Add `POST /api/admin/force-token-reissue { user_id }` (admin role required, re-auth gated).
- Behavior: UPDATE all `api_keys` rows for the user, set `revoked_at = now()`. Audit `token_rotate` per row.
- Web side OPTIONAL (admin can call via curl with admin session for v1). Document in `docs/auth.md`.
<acceptance_criteria>
Unit test against fixture DB: 3 `api_keys` for user → POST endpoint → all 3 `revoked_at` set, agent reconnect attempts fail.
</acceptance_criteria>

</tasks>

**Outputs:** security headers, hardened rate limits, anti-replay, equal-time login, alg pinning verified, audit-event coverage, admin force-revoke.

**Verification:** all G.* tests green; manual smoke of `curl -I` shows headers, rate-limit responses include `Retry-After`.
