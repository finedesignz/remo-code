# Phase 5 fork panel - LOCKED VERDICT

Seats: A (sonnet, refute-first), B (sonnet, blast-radius), Codex (read-only judge). Raw: seat-A.md, seat-B.md, seat-codex.md. All three: ACCEPT-WITH-AMENDMENT on every fork.

| Fork | LOCKED |
|---|---|
| F1 never-merge enforcement | B (GitHub ruleset as preventive control) + A (hub detective layer); prompt advisory only |
| F2 proof state | A: new table orchestrator_proof_runs |
| F3 proof prompt | A: prompt override keyed on the claimed proof run, macro_task_type stays 'dev' |

## Mandatory amendments (planner MUST encode each as a task + test)

F1
- "PR + green required check" is NOT preventive (dev macro squash-merges on green, task-macros.ts:127-136). The asserted ruleset on the default ref must be: update-restriction / branch-lock (preferred) OR required approving review the PR author cannot self-supply, PLUS required checks, PLUS zero bypass actors.
- Freeze ruleset id + normalized config digest (and updated_at) at arm; re-assert before EVERY proof dispatch; fail closed on 403/404/ambiguity/drift -> proof terminal `proof_protection_unverifiable` / `proof_protection_drift`.
- Detective layer: check for any commit landed on default branch since arm-time base_sha (not just HEAD equality) -> terminate + notify.
- Agent credential must be non-admin (cannot edit/delete ruleset): runbook item + arm-time assertion where readable.
- GitHub App today has Contents/Metadata/PRs only (docs/HANDOFF.md:45-49). Code requests Administration-read + Checks-read; absence => arm fails closed. Granting the permissions is an OWNER runbook step (part of the go/no-go gate).
- Orchestrator session is exempt from the git-push scrub (claude-runner.ts:164) -> credential scrubbing (option C) is NOT relied on.

F2
- Arm/disarm are single transactions under a per-user advisory xact lock: recheck exactly-one allowlist + no non-terminal proof, create/convert disabled task, write/remove allowlist row, insert/terminalize proof row.
- DB-enforced: status CHECK, positive frozen-budget CHECKs, partial unique index for single-flight (one non-terminal proof per user; unique repo_ident among non-terminal).
- Budget accounting must not lose tokens when a session is deleted (token_usage.session_id ON DELETE SET NULL, schema.sql:1334): attribute via proof-owned key / fail closed if attribution is impossible.
- Idempotent DDL via the DO-block pattern (schema.sql:314-316).

F3
- proofGuard returns the claimed proof-run snapshot used to render; atomic armed->running before render; no second lookup.
- Any lookup/render error or a proof-owned task with no override => NO injection. Never fall back to the dev macro prompt.
- Test greps the FINAL injected string: no merge / deploy / push-to-main instructions.
- Rollback order: engage session kill switch or transactionally disable+disarm task FIRST, then unset flags (an online session bypasses the autospawn branch, inject.ts:254-267). Runbook must say so.
