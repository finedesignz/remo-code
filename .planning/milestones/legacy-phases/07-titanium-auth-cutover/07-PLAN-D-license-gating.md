# 07-PLAN-D: License gating middleware

**Stage:** D
**Wave:** 2 (depends on A, B; parallel with C)
**Mode:** standard
**TDD:** yes
**Requirements:** R-AUTH-06 (partial), R-AUTH-04 (license-side)

<read_first>
- `07-CONTEXT.md` "License gating — ON from D0, single-track", exclusion list (load-bearing)
- `07-PATTERNS.md` row for `license-gate.ts`
- `hub/src/index.ts` — mount order; license-gate goes AFTER authMiddleware, before route handlers
- `hub/src/titanium-client.ts` (PLAN-A output)
- `hub/src/db/dal.ts` `updateLicenseStatus` (PLAN-B)
</read_first>

<tasks>

### D.1 Implement `hub/src/license-gate.ts`
- `licenseGate({ readOnlyGraceDays = 7 }): MiddlewareHandler`
- On each request:
  - Read `userId` from context (set by authMiddleware).
  - Load `users.license_status`, `license_id`, `license_checked_at` from DAL.
  - If `license_checked_at` older than 5 min (TTL): re-query Titanium via `titanium-client.validateLicenseKey` OR `keygenAdmin.getLicenseForUser`, call `dal.updateLicenseStatus`.
  - On `ACTIVE` → `await next()`.
  - On `EXPIRED` within `readOnlyGraceDays` → if method is GET → pass; else `402 { error: 'license_required', state: 'expired_grace' }`.
  - On any other state → `402 { error: 'license_required', state: '<state>' }`.
  - Always call `titanium-client.assertNotBlocked(titanium_subject)` (real-time blocklist).
- Records `auth_events` with `event_type='license_check_failed'` on 402 (throttled to 1/min/user to avoid spam).
<acceptance_criteria>
`hub/test/license-gate.test.ts` covers each state branch. Green.
</acceptance_criteria>

### D.2 Wire `licenseGate()` into `hub/src/index.ts`
- Apply to: all `/api/*` mutating routes AND all dashboard HTML routes.
- DO NOT apply to (exclusion list from CONTEXT.md):
  - `GET /health`
  - `/api/sentry/*/envelope/`
  - `/ws/agent`
  - `/ws/supervisor`
  - `/api/coolify/webhook/*`
  - `/webhooks/titanium/license-changed`
  - `GET /openapi.json`, `GET /docs`
- Implementation: apply globally INSIDE the auth-required catch-all THEN allow-list GETs that don't need it (e.g. `GET /api/profile` works during grace). Planner picks: route-by-route opt-in vs middleware with method check. Recommend method check + path-prefix allow-list inside the middleware itself for less foot-gun.
<acceptance_criteria>
Manual smoke: with stub Titanium returning `EXPIRED` (3 days), GET `/api/profile` works, POST `/api/scheduled-tasks` returns 402. With stub returning `ACTIVE`, both work. With user on the Redis blocklist, both return 402.
</acceptance_criteria>

### D.3 Optional `POST /webhooks/titanium/license-changed`
- New `hub/src/api/webhooks-titanium.ts`. Mounted OUTSIDE the auth catch-all (public).
- HMAC verify: header `X-Titanium-Signature: sha256=<hex>` over raw body, constant-time compare against shared secret (env `TITANIUM_WEBHOOK_SECRET` — add to config, optional).
- Body: `{ subject, license_status, license_id }`. On verify success: `dal.updateLicenseStatus(userId_by_subject, status, license_id)`, log `auth_events`.
- If `TITANIUM_WEBHOOK_SECRET` unset: route returns 503 (`not_configured`) — keeps the route mounted but inert until Titanium ships webhooks.
<acceptance_criteria>
`hub/test/webhooks-titanium.test.ts` covers: valid HMAC → 200, bad HMAC → 401, replay (>5min skew) → 401, missing secret env → 503.
</acceptance_criteria>

### D.4 License cache (5-min TTL)
- In-memory `Map<userId, { state, checkedAt }>`. TTL 5 min (from env `TITANIUM_LICENSE_CACHE_TTL_SECONDS`).
- Single cache shared across requests in the same hub process.
- Invalidated on webhook receive (D.3) AND on `updateLicenseStatus` call.
<acceptance_criteria>
Repeated requests within 5 min hit cache (verifiable via `console.log` count or test spy). Webhook receive evicts. Unit-tested in `license-gate.test.ts`.
</acceptance_criteria>

</tasks>

**Outputs:** `license-gate.ts`, optional webhook receiver, wired into index. Gate live behind the existing auth.

**Verification:** D.* tests green; manual smoke with stub Titanium covering each license state.
