# 07-PLAN-E: User migration script

**Stage:** E
**Wave:** 3 (depends on A, B; runs ONCE in prod before D0 cutover-start)
**Mode:** standard
**TDD:** yes (dry-run snapshot test)
**Requirements:** R-AUTH-03

<read_first>
- `07-CONTEXT.md` "Email-collision policy" + `<specifics>` "Files to create"
- `07-RESEARCH.md` §2.1, §2.2
- `07-PATTERNS.md` row for migration script
- `hub/scripts/dump-openapi.ts` — script structure
- `hub/src/titanium-client.ts` (PLAN-A) — admin Keygen calls
- `hub/src/db/dal.ts` user helpers (PLAN-B)
</read_first>

<tasks>

### E.1 Implement `hub/scripts/migrate-users-to-titanium.ts`
- Bun script. Flags: `--dry-run` (DEFAULT — must opt in to mutate), `--apply`, `--batch-size=50`, `--batch-delay-ms=5000`, `--output=migration-log.json`.
- Behavior per user row:
  1. Skip if `titanium_subject IS NOT NULL` (already linked).
  2. Call `titanium-client.keygenAdmin.findUserByEmail(user.email)`.
  3. If **NOT FOUND**: `--apply` → `keygenAdmin.createUser({ email })` → `dal.linkTitaniumSubject(user.id, keygenUser.id, email)` → mark `welcome_email_pending`.
  4. If **FOUND + `email_verified=true`**: `--apply` → `dal.setPendingVerify(user.id, keygenUser.id, email)` → mark `verify_email_pending`.
  5. If **FOUND + `email_verified=false`**: log as `requires_titanium_verification`, do NOT touch DB.
- After all DB ops, send the queued emails (welcome OR verify magic-link) via emails4agents. Single email per user.
- Output `migration-log.json` to `.planning/phases/07-titanium-auth-cutover/migration-log.json` (path passed via `--output`). Schema:
  ```json
  {
    "ran_at": "<iso>",
    "mode": "dry-run|apply",
    "total_users": N,
    "linked_new": N,
    "linked_pending_verify": N,
    "skipped_already_linked": N,
    "skipped_requires_titanium_verification": N,
    "errors": [{ "user_id", "email", "error" }],
    "details": [{ "user_id", "email", "action", "keygen_user_id?" }]
  }
  ```
- Resumable: re-running the script is safe (idempotency via "skip if already linked").
<acceptance_criteria>
Script runs without `--apply` against a test DB and prints a dry-run report — DB unchanged. With `--apply` against a controlled fixture set (2 users: one new, one existing-in-Titanium), correctly links one and sets `pending_verify` on the other. Re-running with `--apply` is a no-op (counts move to `skipped_already_linked`).
</acceptance_criteria>

### E.2 Test `hub/test/migrate-users-to-titanium.test.ts`
- Mocks `keygenAdmin.*` to a stub.
- DB-gated (`REMO_E2E_DB_URL`).
- Covers: dry-run safety, --apply correctness on each branch (new / pending / requires-verification / error), idempotency, batch pacing.
<acceptance_criteria>
All branches covered, all assertions green. Test runtime <10s with batch-delay-ms=10.
</acceptance_criteria>

### E.3 Runbook entry in `docs/auth.md`
- Document: env vars required to run, recommended dry-run-first workflow, how to interpret `migration-log.json`, how to handle errors (most common: `requires_titanium_verification` → operator emails user separately).
<acceptance_criteria>
`docs/auth.md` exists and includes a "Migration runbook" section. Linked from `README.md` and `CLAUDE.md`.
</acceptance_criteria>

</tasks>

**Outputs:** migration script + test + runbook. NOT run against prod yet — that happens at D0 in the cutover commit (Stage I).

**Verification:** dry-run on a copy of prod DB produces a report with sensible counts.
