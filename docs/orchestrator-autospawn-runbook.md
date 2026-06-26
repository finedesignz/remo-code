# Build-Session Autospawn — Flip Runbook (GO / NO-GO)

How to ARM the orchestrator build-session autospawn (milestone BSA) in prod **with
intent**. Autospawn lets the auto-dev orchestrator spawn a hub-visible build session
and drive an allowlisted repo due→PR autonomously. It ships **OFF-by-default with an
EMPTY allowlist**, so it is fully inert until every step below is performed.

> **The flip, the allowlist values, and the final token ceiling are OWNER decisions.**
> Arming autospawn is an **outward-facing autonomy escalation** — the bot will spawn
> sessions and open PRs against real repos on its own. This runbook is the checklist for
> that decision, NOT authorization to perform it. Do not flip on someone else's behalf.

Architecture: [auto-dev-orchestrator.md](auto-dev-orchestrator.md#build-session-autospawn-milestone-bsa).
Flag semantics: [CLAUDE.md](../CLAUDE.md) (`REMO_ORCHESTRATOR_AUTOSPAWN`).

## Pre-reqs

1. **`REMO_ORCHESTRATOR_ENABLED` is already ON** in prod (the live orchestrator path is
   running — autospawn carries this gate; both must be ON). If the orchestrator itself
   is not yet enabled, do the [enablement runbook](orchestrator-e2e-runbook.md) FIRST.
2. **CI green on `main`** — including `hub/test/e2e/orchestrator-autospawn.e2e.test.ts`
   (real-Postgres proof of due build task → `session.start` → park → drain → `pr_url`).
3. Supervisor online for the target user, and the target session row exists (it may be
   offline — that is exactly the case autospawn handles).

## Gate AND-chain (what must ALL hold for a single autospawn)

```
  macro is a dev/build type
  && REMO_ORCHESTRATOR_ENABLED on
  && REMO_ORCHESTRATOR_AUTOSPAWN on
  && repo on the per-user allowlist
  && supervisor online
  && NOT over the daily TOKEN cap
  && NOT over the per-day autospawn LAUNCH-count cap
```

Any miss ⇒ legacy `no_session` / a typed `refused:*` — never a silent over-run.

## Flip steps

### Step 1 — Add the target repo(s) to the allowlist (OWNER decision: which repos)

Default is EMPTY ⇒ autospawn drives nothing. Add ONE repo first.
`repo_ident` = `github://<owner>/<repo>` or `path://<abs-path>` (same format as repo
groups). Use the one-shot operator script (intended entry —
`hub/scripts/create-autospawn-build-task.ts`), or call `addRepoToAutospawnAllowlist`:

```bash
# Operator one-shot (adds the allowlist row AND creates/converts the dev build task):
bun run hub/scripts/create-autospawn-build-task.ts \
  --user <user-id> --session <session-id> --repo "github://finedesignz/<repo>"
```

Verify with `listRepoAutospawnAllowlist(userId)` (or
`SELECT repo_ident FROM orchestrator_autospawn_allowlist WHERE user_id = '<id>'`).

### Step 2 — Ensure a `dev` build task exists for the target session/repo

Autospawn only acts on a macro of build/`dev` type. The 31 live tasks are all
`log_check` — convert/create a `macro_task_type='dev'` task for the target session
(the Step-1 script does this; otherwise use the macro-task-type migration / a one-shot).
Confirm `scheduled_tasks.macro_task_type = 'dev'` for the bound session.

### Step 3 — Set the token ceiling + launch cap (OWNER decision: final numbers)

Conservative defaults ship in code: token cap **50M tokens/day**, launch cap **20/day**.
Set the prod numbers explicitly before arming:

```
REMO_ORCHESTRATOR_DAILY_TOKEN_CAP=<tokens-per-day>        # default 50_000_000
REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES=<launches/day> # default 20
```

The token cap is **non-bypassable** and is what actually bounds a runaway loop (the
dollar cost cap is meaningless on a flat-rate Max subscription). Non-positive/non-finite
DISABLES a cap (fail-open) — do NOT set them to 0 in prod.

### Step 4 — Flip the gate (OWNER decision)

In Coolify, set on the hub app and redeploy:

```
REMO_ORCHESTRATOR_AUTOSPAWN=1
```

### Step 5 — MONITOR the first real autospawn

Watch `routine_run_log` for the target session:

- A `command = 'autospawn-launch'` row appears (the spawn fired) — confirms
  `session.start` reached the supervisor and the macro prompt was parked.
- On the launched runner's drain + simulated/real reply, a later tick reconciles
  `routine_run_log.pr_url` (the dead-end this milestone closes). Confirm a real `pr_url`
  lands.
- Confirm the token cap + launch cap engage as expected; cross-check
  `GET /api/usage/cost` and today's token total.

```sql
SELECT created_at, command, outcome, pr_url
FROM routine_run_log r JOIN sessions s ON s.id = r.session_id
WHERE s.user_id = '<id>' ORDER BY created_at DESC LIMIT 20;
```

## Rollback

- **Instant disable:** set `REMO_ORCHESTRATOR_AUTOSPAWN=0` (or unset) and redeploy. The
  seam returns to the legacy `no_session` no-op — no spawns, no behavior change.
- **Narrower:** empty the allowlist
  (`DELETE FROM orchestrator_autospawn_allowlist WHERE user_id = '<id>'`) — autospawn
  fail-closes to `refused:not_allowlisted` for every repo while leaving the flag on.
- Autospawn NEVER auto-merges to main — merge stays the off-hours window-gated
  `runMergeToMain` path, so a rollback cannot strand a half-merged change.

## Out of scope (explicit)

Flipping `REMO_ORCHESTRATOR_AUTOSPAWN=1`, choosing the allowlist repos, and setting the
final prod token ceiling are **owner-authorized decisions** (outward-facing autonomy).
This milestone ships the capability OFF with conservative defaults; a human arms it.
