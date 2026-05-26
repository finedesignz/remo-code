# Phase 07: Titanium Auth Cutover — Patterns

**Produced:** 2026-05-25
Maps every new file the phase will create to the closest existing analog in the repo. Planner + implementer copy structure + error handling + test layout from the analog.

---

## New files → closest existing analog

| New file | Closest analog | Why |
|---|---|---|
| `hub/src/titanium-client.ts` | `hub/src/api/github.ts` (Gateway-fetch pattern for external service) + `hub/src/scheduler/post-run/github-issue.ts` (credential load from gateway pair) | Both load credentials via gateway, expose a thin typed client, handle network failure gracefully. Match retry + error-taxonomy shape. |
| `hub/src/session.ts` | `hub/src/auth/jwt.ts` (small, focused, exported helpers + module-load-time validation) | Same compact shape — `createAuthSession`, `verifyAuthSession`, `deleteAuthSession`, `extendAuthSession`. Module asserts `SESSION_SECRET.length >= 32` at load. |
| `hub/src/license-gate.ts` | `hub/src/auth/middleware.ts` (Hono middleware reading context, setting context, returning early on failure) | Same `(c: Context, next: Next) => Promise<Response | void>` signature. Returns 402 instead of 401. |
| `hub/src/csrf.ts` | `hub/src/lib/crypto.ts` (small pure helpers, constant-time compare) + `hub/src/api/coolify-webhook.ts` (HMAC verify pattern with constant-time compare on header) | Re-use constant-time compare. Pattern: `issueCsrfToken(sessionId): string`, `verifyCsrfToken(sessionId, headerValue, cookieValue): boolean`. |
| `hub/src/middleware/security-headers.ts` | `hub/src/middleware/rate-limit.ts` (existing Hono middleware pattern under `middleware/`) | Same module location + shape. Single exported function returning a Hono middleware. |
| `hub/src/api/auth.ts` (extend) | `hub/src/api/auth.ts` (current — keep legacy routes behind flag, add new routes) | Append `request-link`, `callback`, `logout`. Wrap existing `/login` + `/register` in `if (config.allowLegacyLogin)`. |
| `hub/src/api/webhooks-titanium.ts` | `hub/src/api/coolify-webhook.ts` (HMAC-signed public webhook with raw-body-before-parse) | Identical pattern: raw body, HMAC header verify, constant-time compare, ≤5min skew, JSON parse after verify. |
| `hub/scripts/migrate-users-to-titanium.ts` | `hub/scripts/dump-openapi.ts` (Bun script, in-process module loading, harmless env defaults) | Same shape: top-level script, env validation, structured stdout JSON output. Adds `--dry-run` (default) and `--apply` flags. |
| `hub/src/db/dal.ts` extensions | `hub/src/db/dal.ts` (existing user/session helpers) | Add: `getUserByTitaniumSubject`, `linkTitaniumSubject`, `promoteCandidateSubject`, `updateLicenseStatus`, `recordAuthEvent`, `createAuthSession`, `getAuthSessionById`, `deleteAuthSession`, `purgeExpiredAuthSessions`. Match existing parameter/return conventions. |
| `web/src/pages/Login.tsx` | existing `web/src/components/LoginPage.tsx` (current password form — refactor in place) | Replace password+email form with email-only + "Send magic link" CTA. Keep the same Tailwind palette (rule #15: indigo accent). |
| `web/src/pages/AuthCallback.tsx` | New surface, no direct analog. Closest: `web/src/components/SettingsPage.tsx` (page-level component with loading/error states). | Render loading spinner → on success redirect to `/`, on failure show error + back-to-login. |
| `web/src/lib/hubFetch.ts` (extend) | `web/src/lib/hubFetch.ts` (existing) | Add `credentials: 'include'` + `X-CSRF-Token` header read from cookie before every mutation. |
| `hub/test/titanium-client.test.ts` | `hub/test/scheduler.test.ts` (Bun test pattern, no DB required, fixture-driven) | Golden-vector fixtures under `hub/test/fixtures/titanium-vectors.json`. |
| `hub/test/session.test.ts` | `hub/test/scheduled-tasks.e2e.test.ts` (DB-using test, skip if `REMO_E2E_DB_URL` unset) | E2E for session create/verify/expire/delete. |
| `hub/test/license-gate.test.ts` | `hub/test/coolify-webhook.test.ts` (Hono context mock, middleware-under-test pattern) | Mock context, assert 402 vs allow vs read-only-grace. |
| `hub/test/csrf.test.ts` | `hub/test/post-run-github-issue.test.ts` (small unit test, no DB) | Token issue + verify + tamper rejection. |
| `hub/test/auth-events.test.ts` | `hub/test/scheduler.test.ts` (in-memory or fixture, DB optional) | Assert every endpoint writes the expected row. |
| `TEMPLATE.md` (planning artifact) | No direct repo analog. Use architect template `~/.claude/plans/cheeky-watching-crystal.md` structure as the model. | Stack-agnostic + per-stack adapter sections. |

---

## Reused conventions

- **Idempotent schema migrations:** `CREATE TABLE IF NOT EXISTS …` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`. Pattern established repo-wide; new Phase 07 columns + tables follow it.
- **Module-load-time env validation:** match `hub/src/auth/jwt.ts` line 4 (`if (config.jwtSecret.length < 32) throw …`). Every new secret env var gets the same gate.
- **Gateway credential load:** new Titanium client uses `loadCredentials` / `loadIntegrationConfig` from `@mcp/shared` IF the user wires Titanium creds into the gateway pair. Otherwise, directly env-var-loaded (admin token is script-time only — gateway is overkill). Planner picks based on whether the user wants Titanium tokens to rotate via gateway.
- **WS protocol changes:** all changes go through `hub/src/ws/protocol.ts` with Zod schemas. Phase 07 changes are additive — adds `csrf_token` optional field to mutating message types, no shape changes to existing types.
- **Error response shape:** `c.json({ error: 'string_code' }, status)`. New codes: `re_auth_required` (401), `license_required` (402), `csrf_mismatch` (403), `link_mismatch` (409).
- **Test scaffolding:** Bun's built-in `test` + `expect`. Match `hub/test/scheduler.test.ts` import style.

---

## Anti-patterns to avoid (Karpathy rule #11)

- DO NOT refactor `hub/src/api/auth.ts` beyond the additions + the `if (allowLegacyLogin)` guard.
- DO NOT touch `hub/src/ws/agent.ts` or `hub/src/ws/agent-protocol.ts`.
- DO NOT rename or restructure the existing `sessions` table (Claude conversation sessions). New table = `auth_sessions`.
- DO NOT introduce a new auth abstraction layer "while we're here." `authMiddleware` keeps its current shape; license-gate is a SEPARATE middleware that runs AFTER auth.
- DO NOT centralize `JwtPayload` shape rewrites. The internal context (`c.get('userId')` etc.) stays identical so downstream handlers are untouched.
- DO NOT add ORM/query-builder dep "to make this cleaner." Continue using `hub/src/db/postgres.ts` raw `sql` template literals.
- DO NOT bundle the security-headers + rate-limit changes into the same commit as the auth swap. Separate commits per Stage A–J.

---

*Patterns: 07-titanium-auth-cutover*
