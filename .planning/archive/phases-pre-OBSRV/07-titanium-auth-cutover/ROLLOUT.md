# Phase 07 — Titanium Auth Cutover: Rollout Runbook

**Audience:** human operator executing the D0 → D14 cutover.
**Branch:** `phase-07-titanium-auth-cutover`
**Worktree (operator only):** `C:\Users\artic\GitHub\remo-code-phase-07-titanium-cutover`
**Production target:** `app.remo-code.com` (Coolify, port 3040)

The cutover runs over **two weeks**. D0 = legacy + Titanium both accepted (`ALLOW_LEGACY_LOGIN=true`); D14 = Titanium only. Phase 07.5 (column drop + bcrypt removal) is a SEPARATE follow-up branch spawned the day after D14 holds.

---

## Pre-flight checklist (run T-24h before D0)

- [ ] Coolify env vars set on the hub app:
  - `TITANIUM_KEYGEN_API_URL` (prod Keygen base URL)
  - `TITANIUM_ACCOUNT_ID`
  - `TITANIUM_PRODUCT_ID`
  - `TITANIUM_JWKS_URL`
  - `MAGIC_LINK_SECRET` (≥32 chars, fresh)
  - `SESSION_SECRET` (≥32 chars, fresh)
  - `JWT_SECRET` (existing — DO NOT rotate yet; rotation happens D14+1)
  - `ALLOW_LEGACY_LOGIN=true` (must be `true` for D0)
  - `E4A_API_KEY`, `E4A_BASE_URL`, `E4A_INBOX_ID` (magic-link delivery; per global rule #7)
  - `REDIS_URL` (jti single-use store + license cache)
- [ ] Redis reachable from the hub container: `redis-cli -u $REDIS_URL ping` → `PONG`
- [ ] JWKS endpoint reachable: `curl -fsS $TITANIUM_JWKS_URL | jq '.keys | length'` → ≥1
- [ ] Dry-run migration green:
      ```
      bun run hub/src/scripts/migrate-users-to-titanium.ts --dry-run
      ```
      Read the report. Confirm `requires_titanium_verification` <5% of the total.
- [ ] Single-test-user smoke pass: operator runs the entire TEST-MATRIX rows 1–17 against **staging** with operator email. NO fails on rows 1–4, 12, 13a–13c.
- [ ] Agent regression baseline captured BEFORE deploy:
      ```sql
      SELECT count(*) AS active_agents FROM agent_connections WHERE last_seen > now() - interval '5 minutes';
      SELECT count(*) AS msg_rate FROM messages WHERE created_at > now() - interval '5 minutes';
      ```
      Record both numbers in deploy log.
- [ ] On-call has rollback creds + this doc open.

---

## D0 — Deploy hub + migrate users

**T-0: Deploy**

```powershell
# From operator workstation, in the worktree
cd C:\Users\artic\GitHub\remo-code-phase-07-titanium-cutover
git push origin phase-07-titanium-auth-cutover

# Trigger Coolify redeploy (uses the API; token in ~/.claude/secrets/services.json)
# Operator decides: Coolify UI button OR the gh CLI workflow if one is wired.
```

**T+5m: Run migration against prod**

```powershell
# DESTRUCTIVE: writes to users.titanium_subject + titanium_link_status.
# Reversible via Phase 07-E rollback script.
bun run hub/src/scripts/migrate-users-to-titanium.ts --apply --batch-size=50 --batch-delay-ms=300000 `
  --log .planning/phases/07-titanium-auth-cutover/migration-log-prod.json
```

**T+5m → T+35m: 30-min monitoring window**

Run every 5 min:

```sql
-- READ-ONLY: auth event mix over the last 5 min
SELECT event_type, count(*)
FROM auth_events
WHERE ts > now() - interval '5 minutes'
GROUP BY 1
ORDER BY 2 DESC;
```

```sql
-- READ-ONLY: failed-login storm detector
SELECT date_trunc('minute', ts) AS minute, count(*) AS failed
FROM auth_events
WHERE event_type = 'login_failed' AND ts > now() - interval '30 minutes'
GROUP BY 1
ORDER BY 1 DESC;
```

```sql
-- READ-ONLY: agent traffic delta vs baseline
SELECT count(*) AS active_agents
FROM agent_connections
WHERE last_seen > now() - interval '5 minutes';
```

**Go/No-Go @ T+30m:**
- GO if `login_success > login_failed` AND `active_agents` within ±10% of baseline AND no `link_mismatch` spike.
- NO-GO otherwise → execute D0 rollback below.

Record decision in `.planning/phases/07-titanium-auth-cutover/soak-log.md`.

---

## D7 — Nudge unlinked users

**T-0: Run nudge query**

```sql
-- READ-ONLY: users not yet linked to Titanium
SELECT id, email
FROM users
WHERE titanium_subject IS NULL OR titanium_link_status IS NULL OR titanium_link_status = 'pending_verify';
```

**T+1h: Send nudge email** (via emails4agents per global rule #7) to that list. Template:

> Subject: Action required: link your remo-code account to Titanium
>
> Hi —
>
> remo-code is moving to Titanium-based sign-in next week (D14, exact date). To keep your account working, click the link below to sign in via magic link — that one click will link your account automatically. No password needed.
>
> [Sign in to remo-code](https://app.remo-code.com/login)
>
> After D14, the legacy email + password form will be removed. If you have not signed in via magic link by then, you will need to use the magic-link flow on next visit.
>
> Questions: reply to this email.

**T+2h: UI change**

Set in Coolify on the web build vars:

```
VITE_HIDE_LEGACY_LOGIN_HINT=true
```

Redeploy web only. The legacy password form REMAINS functional (still gated by `ALLOW_LEGACY_LOGIN=true`) but the "use password instead" link on `/login` is hidden, so all new sessions go via magic link.

---

## D14 — Final cutover

**Pre-flight (T-2h):** rerun the D0 monitoring queries. Confirm `login_failed < 1%` of `login_request` over the last 24h. If higher, postpone D14 by 7 days and investigate.

**T-0: Flip the flag**

In Coolify on the hub app, set:

```
ALLOW_LEGACY_LOGIN=false
VITE_HIDE_LEGACY_LOGIN=true
```

Redeploy hub + web.

**T+0 → T+60m: 1-hour monitoring window**

Run the D0 monitoring queries every 5 min. Watch for:
- `login_failed` spike from users still on legacy
- `legacy_login_attempt` events (Plan G should emit one when the form is submitted post-cutover)

```sql
-- READ-ONLY: post-cutover legacy attempts (should trend to zero)
SELECT count(*)
FROM auth_events
WHERE event_type = 'legacy_login_attempt' AND ts > now() - interval '1 hour';
```

**T+60m: Decision**
- HOLD if `legacy_login_attempt` is non-zero but trending down AND no `login_failed` storm → record in soak log, monitor for 24h.
- ROLLBACK if `login_failed > 20%` of `login_request` in any 5-min window → execute D14 rollback below.

---

## D14+1 — Phase 07.5 spawn (separate branch)

When 24h post-D14 shows zero auth regressions:

1. Spawn `feat/phase-07-5-bcrypt-removal` off `main` in a fresh worktree.
2. In that branch:
   - Drop the `users.password_hash` column (DESTRUCTIVE migration; back up first).
   - Remove `bcryptjs` / `bcrypt` from `hub/package.json`.
   - Delete `hub/src/auth/password.ts` and its tests.
   - Delete the legacy `/api/auth/login` (password-bearing) handler.
   - **Rotate `JWT_SECRET`** in Coolify (forces all sessions to re-auth via magic link).
   - Remove `ALLOW_LEGACY_LOGIN` env var.
   - Update `docs/auth.md` to remove all references to password login.
3. Open PR; merge after green CI + 1 reviewer.
4. Mark Phase 07 + 07.5 Complete in ROADMAP.md.

---

## Rollback plans

### D0 rollback (within 30-min window)

Root cause: `login_failed` storm, agent regression, or any of rows 1–4 / 12 of TEST-MATRIX failing in prod.

```powershell
# 1. Revert hub deploy to the prior image via Coolify UI (Deployments → previous → Redeploy).
#    OR git revert + push:
cd C:\Users\artic\GitHub\remo-code-phase-07-titanium-cutover
git revert <merge-commit-sha-of-phase-07-on-main>  # ONLY if phase-07 was merged to main; otherwise just don't merge
git push origin main

# 2. Run the migration rollback script (Phase 07-E shipped this):
bun run hub/src/scripts/migrate-users-to-titanium.ts --rollback `
  --log .planning/phases/07-titanium-auth-cutover/migration-log-prod.json

# 3. Verify rollback:
psql $DATABASE_URL -c "SELECT count(*) FROM users WHERE titanium_subject IS NOT NULL;"
# Expect: 0 (rollback nulls these out)
```

### D14 rollback (within 1-hour window)

Root cause: legacy-only users locked out post-cutover, OR Titanium Keygen outage.

```powershell
# 1. In Coolify, flip back:
#    ALLOW_LEGACY_LOGIN=true
#    VITE_HIDE_LEGACY_LOGIN=false
# 2. Redeploy hub + web (no code change, just env flip).
# 3. Communicate to users via emails4agents: "Cutover postponed; please retry."
# 4. Investigate. Re-attempt D14 after fix + 7-day re-soak.
```

### D14+1 rollback (Phase 07.5)

Root cause: dropped `password_hash` column, then realized we need it back.

**This is destructive and one-way.** The column drop is in a separate branch so a `git revert` of that PR DOES NOT restore the column data. To recover, restore the `users` table from the pre-Phase-07.5 backup:

```powershell
# DESTRUCTIVE: overwrites current users table. Operator confirms before running.
psql $DATABASE_URL -c "BEGIN; ALTER TABLE users ADD COLUMN password_hash TEXT; ..."
# Then COPY in the password_hash column from the backup. Operator scripts this case-by-case.
```

Phase 07.5 PR description MUST link the backup location. If it doesn't, do NOT merge.

---

## On-call runbook — common failures

### Redis down → magic-link 503

Symptom: `POST /api/auth/login/request-link` returns 503; hub logs `redis: ECONNREFUSED`.

First response:
1. `redis-cli -u $REDIS_URL ping` from the hub container. If timeout → Redis instance down.
2. Restart the Redis container in Coolify.
3. If Redis won't come back within 10 min → set `MAGIC_LINK_JTI_STORE=memory` in Coolify env, redeploy hub. **Trade-off:** jti single-use becomes per-process; magic-link replay protection weakens across multi-instance deploys. Acceptable as a temporary unblock; restore Redis ASAP.
4. Communicate to users: "Sign-in temporarily degraded; please retry in 5 minutes."

### JWKS unreachable → hub boots but `/api/profile` returns 500

Symptom: hub boots fine but every JWT verify fails with `jwks_fetch_failed`.

First response:
1. `curl -fsS $TITANIUM_JWKS_URL` from the hub container. If timeout → Keygen down OR network ACL.
2. Check Titanium status page / Slack.
3. **Do NOT roll back the hub** — JWKS outage is a Titanium dependency, not a hub bug. Existing cookie sessions keep working as long as the JWKS cache is warm; only NEW sign-ins fail.
4. If Titanium is down >30 min → escalate to Titanium on-call. Communicate to users.

### Mapping conflicts >10% of users

Symptom: dry-run migration report shows `requires_titanium_verification` >10% of total users.

First response:
1. STOP — do not run `--apply`.
2. Investigate the mismatched emails: most likely cause is users who registered with a different email in Titanium than in remo-code.
3. Run targeted nudge email to the unmatched cohort BEFORE D0, asking them to sign in to Titanium with their remo-code email first.
4. Re-run dry-run after 48h. Only proceed when <5%.

### `auth_events` storm of `link_mismatch`

Symptom: high rate of `link_mismatch` events post-D0.

First response:
1. Inspect a sample: `SELECT * FROM auth_events WHERE event_type = 'link_mismatch' ORDER BY ts DESC LIMIT 20;`
2. `link_mismatch` = magic-link callback found a user whose `titanium_subject` does not match the subject in the magic-link JWT. Indicates the mapping job linked the wrong user.
3. If >1% of `login_success`, roll back via D0 rollback path and re-investigate the mapping logic in Plan E.

---

## Decision log

| Date | Stage | Decision | Operator | Notes |
|---|---|---|---|---|
| | Pre-flight | GO / NO-GO | | |
| | D0 T+30m | GO / NO-GO | | |
| | D7 | Nudge sent (count: ) | | |
| | D14 T+60m | HOLD / ROLLBACK | | |
| | D14+24h | Phase 07.5 spawned | | |
