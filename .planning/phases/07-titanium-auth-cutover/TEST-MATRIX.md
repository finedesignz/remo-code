# Phase 07 — Titanium Auth Cutover: 16-Row Test Matrix

> **Note (Phase 09, 2026-05-26):** This historical phase plan references the retired agent/ workspace and channel/ plugin. See .planning/phases/09-retire-npm-packages/ for the retirement details.


**Audience:** human operator running the cutover smoke before D0 deploy, D14 cutover, and any rollback.
**Not:** a unit-test contract. Plans A–G already shipped unit + middleware tests in `hub/test/`. This matrix is the **end-to-end + manual smoke** that exercises real flows against a deployed hub (staging or prod).

**Prereqs**
- Deployed hub reachable at `$HUB_URL` (staging: `https://staging.remo-code.com`; prod: `https://app.remo-code.com`).
- Two browser profiles (clean cookie jar each).
- An operator email with a known license state in Titanium Keygen (`ACTIVE`).
- A second test email with NO Titanium account (for unknown-email + license-missing rows).
- `psql` access to the hub's `DATABASE_URL` for the `auth_events` queries.
- Working agent install (`claude-remote --api-key …`) for the load-bearing row 12.

**Procedure**
1. Run each row top-to-bottom. Fill `actual` + `pass/fail` columns inline.
2. STOP on the first fail in rows 1–4 (auth broken), 12 (agent regression), or 16 (CSRF off) — these are no-go conditions.
3. Capture screenshots / curl transcripts for any fail row in `notes`.
4. Commit the filled matrix back to `.planning/phases/07-titanium-auth-cutover/TEST-MATRIX-<date>-<env>.md` (do NOT overwrite this template).

---

## A. Magic-link flow (rows 1–4)

| # | Scenario | Preconditions | Action | Expected | Actual | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Magic-link happy path | Operator email has `users` row + Titanium subject linked | `POST $HUB_URL/api/auth/login/request-link {email}` → click link in inbox | 200 on request; callback sets `__Host-remo_session` cookie (Secure, HttpOnly, SameSite=Lax); redirect to `/` | | | `auth_events` shows `login_request` + `login_success` |
| 2 | Magic-link replay | Use the token from row 1 a second time | Repeat `GET $HUB_URL/api/auth/login/callback?token=…` | 409 `link_reused`; no cookie set | | | jti single-use store rejects |
| 3 | Magic-link expired | Mint a magic link, wait >15 min (or set system clock forward), then click | `GET …/callback?token=…` after TTL | 410 `link_expired`; no cookie set | | | TTL = 15 min hardcoded in `signMagicLink` |
| 4 | Unknown email request-link | Email NOT in `users` table | `POST …/request-link {email: 'never@seen.com'}` | 200 (enumeration-safe); no email sent; response time within ±100ms of row 1 | | | Check inbox is empty; no `login_request` event for this email |

## B. License-state gating (rows 5–10)

| # | Scenario | Preconditions | Action | Expected | Actual | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| 5 | License ACTIVE → mutating | Operator session from row 1; license ACTIVE in Keygen | `POST $HUB_URL/api/profile {display_name: 'x'}` with cookie + `X-CSRF-Token` | 200 | | | Happy path baseline |
| 6 | License NONE → mutating | Test user with NO Titanium license | Same as row 5 | 402 `license_required`; payload `{ status: 'none' }` | | | Web shows upgrade modal |
| 7 | License EXPIRED in 7d grace → GET | User whose license expired 3d ago | `GET $HUB_URL/api/profile` | 200 with `X-License-Grace: <days>` header | | | Grace = 7d window |
| 8 | License EXPIRED beyond grace → any | User whose license expired 14d ago | `GET $HUB_URL/api/profile` | 402 `license_expired` | | | Read AND write blocked beyond grace |
| 9 | License BANNED → all routes | User with `banned` state in Keygen | `GET …/profile` and `POST …/profile` | 402 `license_banned` on both | | | No grace for ban |
| 10 | Webhook flip ACTIVE→BANNED mid-session | Active operator session; in Keygen admin, flip license to `banned` and trigger webhook | Within 5 min, retry `POST …/profile` | 402 `license_banned` within 5min cache window | | | Watch hub logs for `license_cache_invalidated` |

## C. Token gating + agent regression (rows 11–12)

| # | Scenario | Preconditions | Action | Expected | Actual | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| 11a | Dual-auth: cookie path | Valid `__Host-remo_session` cookie, no Authorization header | `GET $HUB_URL/api/profile` with cookie | 200 | | | Web SPA path |
| 11b | Dual-auth: legacy bearer | Valid JWT in `Authorization: Bearer …`, no cookie | Same as 11a with header only | 200 | | | Backward-compat for any pre-cutover SPA tab |
| 11c | No creds → 401 | Neither cookie nor bearer | `GET …/profile` | 401 `unauthorized` | | | |
| 11d | Token-mutating without re-auth | Valid session >5 min old, op marked re-auth-required | `POST $HUB_URL/api/account/keygen-api-key/rotate` | 401 `re_auth_required` | | | Plan G re-auth gate |
| 12 | **LOAD-BEARING:** agent `api_keys` flow | Working agent install with existing `remo_…` api_key | `claude-remote --api-key <key>` from a clean shell | Agent connects to `/ws/agent`, authenticates, spawns Claude CLI, accepts first user message from web UI | | | **If this fails, ROLLBACK immediately.** Zero-regression acceptance criterion. |

## D. CSRF (rows 13a–13d)

| # | Scenario | Preconditions | Action | Expected | Actual | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| 13a | Mutating REST missing `X-CSRF-Token` | Valid cookie session | `curl -X POST …/api/profile -H "Cookie: …" -d '{}'` (no CSRF header) | 403 `csrf_mismatch` | | | |
| 13b | Mutating REST wrong CSRF | Valid cookie + header `X-CSRF-Token: deadbeef` | Same as 13a with bad header | 403 `csrf_mismatch` | | | |
| 13c | Mutating REST matching CSRF | Valid cookie + correct token from `/api/csrf` | `POST …/profile` with both | 200 | | | |
| 13d | WS mutating without `csrf_token` | WS client connects, sends `send_message` payload missing `csrf_token` field | `{ type: 'send_message', content: 'hi' }` | WS sends `{ type: 'error', code: 'csrf_mismatch' }`; message NOT persisted | | | Plan G WS CSRF |

## E. Session lifecycle (rows 14a–14d)

| # | Scenario | Preconditions | Action | Expected | Actual | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| 14a | Idle 60m boundary | Session unused for 60 min | Send request at min 59 then again at min 61 | 59: 200; 61: 401 `session_idle` | | | Adjust system clock for test |
| 14b | Absolute 7d boundary | Session age = 7d + 1 min (override via test seam) | Any request | 401 `session_expired_absolute` | | | |
| 14c | Logout invalidates cookie | Valid session | `POST $HUB_URL/api/auth/logout` then `GET …/profile` with old cookie | logout: 204; profile: 401 | | | Cookie cleared + server-side session deleted |
| 14d | Re-auth refuses session age >5m | Session age = 6 min; protected op | `POST …/account/keygen-api-key/rotate` | 401 `re_auth_required` | | | Already covered by 11d; explicit boundary check |

## F. JWKS rotation (rows 15–17)

| # | Scenario | Preconditions | Action | Expected | Actual | Pass/Fail | Notes |
|---|---|---|---|---|---|---|---|
| 15 | JWKS key rotation hot-swap | Rotate signing key in Titanium Keygen; old + new both in JWKS | Mint new magic link; old session cookie remains valid | New cookie verifies under new `kid`; old cookie verifies under old `kid` until expiry | | | |
| 16 | Unknown kid → JWKS refetch | Tamper a JWT to claim a `kid` the hub has never seen | `GET …/profile` with tampered Authorization | Hub fetches JWKS once (cache miss), verifies, fails because `kid` truly does not exist; returns 401 | | | Hub log shows `jwks_refetch kid=…` |
| 17 | JWT tamper rejected | Flip last char of a valid bearer token | `GET …/profile` with mangled bearer | 401 `invalid_token`; no JWKS refetch (signature fails on known key) | | | Bonus row from plan |

---

## Gaps flagged

- **Row 10 (webhook flip):** requires Titanium Keygen webhook infra to actually emit the suspend event. If staging Keygen does not have webhooks wired, downgrade to manual: directly invalidate `license_cache` via `DELETE FROM license_cache WHERE user_id = …` and confirm next request returns 402. Flag as TODO if Plan D did not ship the webhook receiver.
- **Row 13d (WS csrf_token):** verify Plan G actually requires `csrf_token` on WS mutating frames. If not shipped, mark TODO and downgrade to "WS mutating frame requires session cookie at handshake only" (existing behavior).
- **Row 15 (JWKS hot-swap):** requires real Keygen rotation. If staging Keygen is single-key, skip and add to D7 staging exercise.

## Sign-off

- [ ] All 17 rows executed
- [ ] No fails in rows 1–4, 12, 13a–13c
- [ ] Filled matrix committed to `.planning/phases/07-titanium-auth-cutover/TEST-MATRIX-<YYYY-MM-DD>-<env>.md`
- [ ] Go/No-Go recorded in `ROLLOUT.md` decision log
