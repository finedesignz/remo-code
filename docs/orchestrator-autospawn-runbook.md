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

Conservative defaults ship in code: token cap **20M tokens/day** (only where the env is unset), launch cap **20/day**.
Set the prod numbers explicitly before arming:

```
REMO_ORCHESTRATOR_DAILY_TOKEN_CAP=<tokens-per-day>        # default 20_000_000
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

## Arming unified self-heal (flag `REMO_HEAL_UNIFIED`)

The self-heal seam (`docs/self-heal-routing.md`) reuses this autospawn capability to wake an
OFFLINE session bound to a failing repo. Shipping it changes nothing until the owner arms it.

What heal needs, and what it does not:

- **Shared allowlist.** Heal reads the same `orchestrator_autospawn_allowlist` as the orchestrator
  (Step 1). It is EMPTY by default, so a default configuration spawns nothing: live dispatch and
  fail-fast routing still work with the flag ON, autospawn is a no-op.
- **Two flags, not three.** Heal autospawn is armed when `REMO_HEAL_UNIFIED` AND
  `REMO_ORCHESTRATOR_AUTOSPAWN` are ON. It does NOT require `REMO_ORCHESTRATOR_ENABLED`; arming heal
  does not turn the orchestrator live path on, and the orchestrator flag does not arm heal.
- **Order of checks** (governed launch, heal policy): the full gate chain and the atomic lifetime
  reservation (key `heal:<userId>:<repo_ident>`) first, then allowlist and supervisor-online, then
  the `autospawn-launch` ledger row (fail-closed), and the spawn LAST. Any refusal releases the
  reservation, so a refused heal never consumes a supervisor slot. The token cap, launch cap
  (Step 3) and `REMO_HEAL_MAX_PER_REPO_HOUR` / `REMO_HEAL_MAX_PER_TASK_DAY` all bound it.

Flip order (OWNER decision, after Steps 1-3 above):

1. Set `REMO_ORCHESTRATOR_AUTOSPAWN=1` (Step 4) if it is not already on.
2. Set `REMO_HEAL_UNIFIED=1` on the hub app and redeploy. Optional knobs: `REMO_HEAL_DEDUPE_WINDOW_MS`,
   `REMO_HEAL_SPAWN_TIMEOUT_MS`, `REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR`, `REMO_HEAL_MAX_PER_REPO_HOUR`,
   `REMO_HEAL_MAX_PER_TASK_DAY`, `REMO_HEAL_RETENTION_HOURS` (defaults in `docs/self-heal-routing.md`;
   a bad value falls back to the default, it never disables a bound).
3. Add the first repo to the allowlist only when you want an offline-session heal for it (Step 1).

Verify:

```sql
-- every heal decision and its outcome
SELECT created_at, source, repo_ident, outcome, trigger_run_id, dispatch_run_id
FROM heal_events WHERE user_id = '<id>' ORDER BY created_at DESC LIMIT 20;

-- the spawn ledger (same table as Step 5)
SELECT created_at, command, outcome FROM routine_run_log r
JOIN sessions s ON s.id = r.session_id
WHERE s.user_id = '<id>' AND command = 'autospawn-launch' ORDER BY created_at DESC LIMIT 20;
```

Expect `dispatched_live` for repos with a live session, `autospawn_launched` / `autospawn_parked`
(then `dispatched_after_spawn`) only for allowlisted repos, and `no_routable_session` plus one owner
email for the rest. No scheduled-task run should be left `pending` with a NULL `session_id`.

Disarm: unset `REMO_HEAL_UNIFIED` and redeploy. Every source returns to its previous path
byte for byte (the boot sweep also stops). Narrower: empty the allowlist, or set
`REMO_ORCHESTRATOR_AUTOSPAWN=0`, which turns heal autospawn into `no_routable_session` while
leaving live routing on. A heal never merges or deploys.

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
