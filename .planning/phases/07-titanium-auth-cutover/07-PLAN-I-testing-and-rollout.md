# 07-PLAN-I: Testing & rollout

**Stage:** I
**Wave:** 4 (depends on A–H)
**Mode:** standard
**TDD:** matrix is the spec
**Requirements:** R-AUTH-01 through R-AUTH-09 (full coverage)

<read_first>
- Every prior 07-PLAN-* file
- `07-CONTEXT.md` Cutover sequencing section
- `~/.claude/plans/cheeky-watching-crystal.md` Stage I (16-row matrix template)
</read_first>

<tasks>

### I.1 Adapt 16-row test matrix
Document in `hub/test/auth-matrix.md` (and as a test plan referenced from `docs/auth.md`):

| # | Scenario | Expected |
|---|---|---|
| 1 | Magic-link happy path | 200 + cookie + redirect |
| 2 | Magic-link replay | 409 `link_reused` |
| 3 | Magic-link expired (>15m) | 410 `link_expired` |
| 4 | Unknown email request-link | 200 (enumeration-safe), no email sent, equal time |
| 5 | License ACTIVE → mutating route | 200 |
| 6 | License missing → mutating route | 402 |
| 7 | License EXPIRED <7d → GET | 200 |
| 8 | License EXPIRED <7d → mutating | 402 |
| 9 | License BANNED → all routes | 402 |
| 10 | Webhook flips license to SUSPENDED → next mutating request | 402 within 5min |
| 11 | Token-mutating endpoint without re-auth → | 401 `re_auth_required` |
| 12 | Agent `api_keys` flow unchanged (zero regression — LOAD-BEARING) | agent connects + sends messages identically |
| 13 | Mutating REST without `X-CSRF-Token` | 403 `csrf_mismatch` |
| 14 | Session deleted server-side → next request | 401, redirect to /login |
| 15 | Logout endpoint → cookie cleared, session deleted, /api/* → 401 | pass |
| 16 | JWKS rotation: key rotated → fetched on `kid` miss → verify succeeds | pass |
| 17 (bonus) | JWT tampered (last char flipped) | rejected by verifier |

Each row backed by an automated test where feasible; rows that need real Titanium (10, 16) documented as manual smoke against staging.
<acceptance_criteria>
All 17 rows tested. 12+ automated. Manual rows documented step-by-step. CI gate: zero-regression test for row 12 MUST pass on every PR for the phase branch.
</acceptance_criteria>

### I.2 Staging deploy + 1-user smoke
- Deploy hub + web to Coolify staging.
- Run migration script `--dry-run` against staging DB copy.
- Run `--apply` for ONE user (operator's own email).
- Operator completes magic-link flow end-to-end. Verifies dashboard works, license badge green, mutating ops succeed, agent connects unchanged.
<acceptance_criteria>
Operator session lasts ≥30 min without auth-related errors in `auth_events`. Agent traffic unaffected (`/ws/agent` connection count + message rate matches pre-deploy baseline).
</acceptance_criteria>

### I.3 Batch migration in prod
- D0: run `migrate-users-to-titanium.ts --apply --batch-size=50 --batch-delay-ms=300000` against prod.
- Operator monitors `auth_events` for `login_failed` storms via a quick `SELECT event_type, count(*) FROM auth_events WHERE ts > now() - interval '5 minutes' GROUP BY 1` query.
- Migration log written to `.planning/phases/07-titanium-auth-cutover/migration-log-prod.json`. Committed (sensitive emails redacted to first-char + domain).
<acceptance_criteria>
≥95% of users migrated to `linked` or `pending_verify` within 1 hour. <5% in `requires_titanium_verification`. Zero `auth_events.event_type='login_failed'` storms (>10/min sustained).
</acceptance_criteria>

### I.4 30-min post-deploy monitoring window
- Operator runs:
  ```sql
  SELECT event_type, count(*) FROM auth_events
   WHERE ts > now() - interval '30 minutes' GROUP BY 1 ORDER BY 2 DESC;
  ```
- Expected: high `login_request`, growing `login_success`, low `login_failed`, near-zero `link_mismatch`. If `login_failed > login_success`: rollback (revert image).
<acceptance_criteria>
Decision recorded in deploy log: GO (proceed to soak) or NO-GO (rollback via Coolify revert). NO-GO path documented in `docs/auth.md`.
</acceptance_criteria>

### I.5 Soak monitoring (D0–D14)
- Daily check: `auth_events` summary, `mapping_conflicts` (link_mismatch events), `license_check_failed` counts, JWKS fetch failures (log-grep).
- Weekly check at D7: send nudge email to users still unlinked (`titanium_link_status IS NULL OR titanium_subject IS NULL`).
- Anomaly threshold for early abort: `login_failed > 20%` of `login_request` over any 1-hour window → investigate; if root cause is Titanium → rollback by setting `ALLOW_LEGACY_LOGIN=true` + redeploying web with legacy login un-hidden.
<acceptance_criteria>
Daily summary committed to `.planning/phases/07-titanium-auth-cutover/soak-log.md`. D14 entry includes go/no-go for cutover (Stage H execution).
</acceptance_criteria>

### I.6 D14 cutover commit
- Flip `ALLOW_LEGACY_LOGIN=false` in Coolify env.
- Set `VITE_HIDE_LEGACY_LOGIN=true` in Coolify env, redeploy web.
- Rotate `JWT_SECRET` (per PLAN-H.3).
- Monitor for 1 hour post-cutover.
- Phase 07 declared green when 24h post-cutover shows zero auth-related regression tickets.
<acceptance_criteria>
Coolify env flipped. Web redeployed. JWT_SECRET rotated. 24h clean. Phase 07 marked Complete in ROADMAP.md.
</acceptance_criteria>

</tasks>

**Outputs:** test matrix, prod migration log, soak log, cutover commit.

**Verification:** Phase 07 ROADMAP entry transitions to Complete only after I.6 acceptance criterion met.
