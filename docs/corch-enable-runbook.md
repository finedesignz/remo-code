# CORCH enable runbook (cutover items, live proof, rollback)

Milestone CORCH phase 12 (CORCH-R6.5, CORCH-R6.6). This document lists every flag, secret and key step needed to
turn the central orchestrator on, in the order of the roadmap "Live cutover list". **No phase performs any of these
steps.** Each item is owner-gated; the owner (or an agent acting on an explicit owner instruction for that item)
runs it. Nothing here is automatic and nothing in the repo enables a flag.

Rules for every step:

- Environment variable NAMES only appear in this file. Never print, log, paste or commit a value. Secrets live in
  Coolify runtime env and in the owner's secret store.
- Verify with a read-only command or a real route after each item before starting the next.
- Rollback for every item is "set the flag OFF / unset the env, redeploy" unless stated. Turning
  `REMO_CORCH_ENABLED` off stops every dispatch immediately (true no-op); rows already stored are kept.
- Rotating or re-minting any existing key needs separate explicit owner approval; this runbook only mints NEW keys.

Gate classes used below: **OWNER** = an owner action, **12b-4** = credential that exists nowhere until created
(browser-only or account creation), **CUTOVER** = live cutover for real users (rule 12).

## Hard prerequisite found in CORCH-12: hub to memlog transport (BLOCKED-ON-MCP)

The per-item memlog claim (CORCH-R3.8) uses the `MemlogClient` seam in `hub/src/corch/memlog.ts`, which defaults to
refusing `memlog_unavailable`. memlog is a gateway-only MCP Factory server and the hub has no MCP client, so no real
transport exists (7e request already filed to `mcp-servers`, see `docs/corch.md` "Memlog claim"). Until a verified
transport is injected, flipping item 9 would leave every item waiting `memlog_unavailable`. **The live proof (below)
cannot pass before this is resolved.** This is a code prerequisite, not an owner action, and it is not part of items
1-10.

## Order of operations

| # | Item | Gate | Needed by |
|---|---|---|---|
| 1 | Hub key `quota:publish`; CUG `hub_publish_url` + credential | OWNER | CORCH-03 live |
| 2 | Hub key `quota:read` for AAF; AAF `QUOTA_FEED_*` | OWNER | CORCH-07 live |
| 3 | Shared event secret (AAF + hub) | OWNER | CORCH-06/08 live |
| 4 | AAF `CORCH_TRUSTED_PR_AUTHORS` (after CORCH-05b deployed) | OWNER | CORCH-05/05b live |
| 5 | AAF `projects:write` key; hub `REMO_CORCH_AAF_*` | OWNER | CORCH-08 live |
| 6 | gsd-console `gsdc_` token; hub `REMO_CORCH_GSDC_*` | 12b-4 (browser-only mint) | CORCH-04 live |
| 7 | Machine-user GitHub account + repo-scoped git credential | 12b-4 | CORCH-09 live |
| 8 | Linux slot containers + per-slot `host` keys | OWNER | CORCH-10 live |
| 9 | Hub flag `REMO_CORCH_ENABLED` (truthy) | CUTOVER | CORCH-12 live proof |
| 10 | Optional `ext:corch` key + per-project `accept_external` | OWNER (only if an external producer exists) | none in v1 |

The live proof runs between item 8 and a wider rollout, on ONE throwaway repo (see "Live proof procedure").
Items 1-8 do not change production behavior while `REMO_CORCH_ENABLED` is OFF: the hub only stores snapshots,
events and rows.

## Item 1 - quota publish key (CUG to hub)

- Mint a hub API key with scope `quota:publish` through the cookie-only `/api/api-keys` route (an api key can never
  mint a key). Scope is EXPLICIT-only and reaches only `POST /api/quota/snapshot`.
- Configure claude-usage-guard: `hub_publish_url` (hub origin + `/api/quota/snapshot`) and the credential. The key
  is stored in the owner secret store, never printed.
- Verify: after one CUG poll, `GET /api/quota/snapshot` with a `quota:read` key (item 2) lists the account with
  `eligible` and `reason`; or read `corch_quota_accounts` row count for the user is >= 1. A `POST` with a read key
  must answer 403.
- Rollback: unset `hub_publish_url` in CUG; revoke the key only with owner approval. Stored rows are harmless.

## Item 2 - quota read key for AgentAutofix

- Mint a hub key with scope `quota:read` (cookie-only route). Set AAF env `QUOTA_FEED_URL`, `QUOTA_FEED_TOKEN`,
  `QUOTA_FEED_ACCOUNT_ID` (account mapping per assumption A11).
- Verify: AAF fixer logs a quota read at claim time; `GET /api/quota/snapshot` with the read key answers 200.
- Rollback: unset the three `QUOTA_FEED_*` variables on AAF and redeploy (the fixer then fails closed per CORCH-07).

## Item 3 - shared event secret

- Generate one strong random value. Set the SAME value in AAF `CORCH_EVENT_SECRET` and hub
  `REMO_CORCH_AAF_EVENT_SECRET`. Set AAF `CORCH_EVENT_URL` to `<hub origin>/api/corch-events/aaf`. Subscribe the AAF
  GitHub App to the `check_run` event (CORCH-06 outbox).
- Verify: with the hub secret unset the receiver answers 503; once set, an unsigned POST answers 401 and a
  correctly signed `pr.merged` for an unknown head ref answers 200 `ignored` and is audited in `corch_events`.
  Compare secrets by fingerprint only (first 8 hex of sha256), never by value.
- Rollback: unset `REMO_CORCH_AAF_EVENT_SECRET` (receiver returns to 503) and AAF `CORCH_EVENT_URL`.

## Item 4 - AAF trusted PR authors (prerequisite: CORCH-05b)

- **Prerequisite:** CORCH-05b (AAF worker accepts adopted jobs) is merged AND deployed. Verify the AAF deploy
  version contains it before setting anything.
- Set AAF `CORCH_TRUSTED_PR_AUTHORS` to the machine-user login from item 7 (default empty = adoption off).
- Verify: AAF adopts a PR from that login on a repo provisioned in item 5 (see the live proof); an unlisted author
  is not adopted.
- Rollback: empty `CORCH_TRUSTED_PR_AUTHORS` and redeploy AAF.

## Item 5 - AAF provisioning key and hub AAF env

- Create an AAF key with `projects:write`. Set hub `REMO_CORCH_AAF_URL`, `REMO_CORCH_AAF_TOKEN` and
  `REMO_CORCH_AAF_INSTALLATION_ID`. Then, for projects enrolled BEFORE this step, run the one-shot backfill
  `bun hub/scripts/corch-provision-existing.ts` (idempotent). New enrollments provision on enrollment.
- Enroll ONLY the throwaway repo now (`POST /api/corch/projects`, cookie auth). With `REMO_CORCH_ENABLED` OFF the
  route only stores the row, so enrollment is safe before item 9 and lets the provisioning check below run.
- Verify: `corch_projects.aaf_provision_status = 'provisioned'` for the throwaway project; only provisioned
  projects are dispatchable (fail closed).
- Rollback: unset the three variables; unprovisioned projects stay queued and dispatch nothing.

## Item 6 - gsd-console board token

- Mint a gsd-console `gsdc_` token with `board:read` (browser-only mint; gate 12b-4). Set hub `REMO_CORCH_GSDC_URL`
  and `REMO_CORCH_GSDC_TOKEN` (both unset = source off, no connection).
- Verify (configuration only; ingestion does not start while `REMO_CORCH_ENABLED` is OFF): both variables are set
  in the hub env and the token authenticates read-only against the console board API. The live check (hub log shows
  the board SSE connected once; the enrolled repo's next GSD phase appears as a `gsd_console` item; an unreachable
  console adds and cancels nothing, one notification per outage) is DEFERRED to after item 9.
- Rollback: unset both variables and redeploy.

## Item 7 - machine-user GitHub account and git credential

- Create the dedicated machine-user GitHub account (gate 12b-4), grant it WRITE access only to the throwaway repo
  first, and create a repo-scoped token with NO admin and NO merge rights. This becomes `GH_TOKEN` of every slot
  (item 8). Its login is the value for item 4.
- Verify: `gh api repos/<throwaway>` as that user shows `permissions.push=true`, `admin=false`; it must not be able
  to merge (branch protection / AAF is the only merger).
- Rollback: remove the user from the repo. No hub state is involved.

## Item 8 - Linux slot containers and host keys

- One Coolify application per account slot from `Dockerfile.slot` (details: [corch-linux-slots.md](corch-linux-slots.md)).
  Runtime env per slot: `REMO_ACCOUNT_SLOT`, `REMO_HUB_URL`, `REMO_API_KEY` (this slot's own `purpose='host'` key via
  `POST /api/api-keys {host:true}`), `CLAUDE_CODE_OAUTH_TOKEN` (exactly one account, subscription OAuth, never an API
  key), `GH_TOKEN` (item 7). **Do NOT set `REMO_ALLOW_DANGEROUS`** (see A8 below): slots run under the per-slot
  permission allowlist, never `--dangerously-skip-permissions`.
- Verify: `GET /api/supervisors` lists the host `online: true` with `account_slot` equal to `REMO_ACCOUNT_SLOT`;
  `docker exec <c> id -u` is not 0; `docker history --no-trunc <image>` shows no token.
- Rollback: stop the Coolify app. A running session is reclaimed by the hub on lease expiry.

## Item 9 - enable `REMO_CORCH_ENABLED` (live cutover)

- Pre-flight, all live in the same session: `REMO_ORCHESTRATOR_ENABLED` is OFF in the prod hub env (boot refuses
  when both are truthy: `assertCorchConfig`); items 1-8 verified; the memlog transport prerequisite above is
  resolved; `REMO_CORCH_QUOTA_CEILING_PCT` is unset or valid (1-100); the daily token cap is set.
- The throwaway repo is already the only enrolled project (item 5). Set `REMO_CORCH_ENABLED` to a truthy value
  (`1`, `true`, `yes` or `on`) and redeploy the hub. Optional knobs: `REMO_CORCH_LEASE_MS`, `REMO_CORCH_RECONCILE_INTERVAL_MS`.
- Verify: hub boots (no `[startup] FATAL`); `GET /api/corch/queue` answers 200; the deferred item 6 live check passes; the kill switch
  (`POST /api/automation/kill-switch/engage`) is known to work before the first item is queued.
- Rollback: set `REMO_CORCH_ENABLED` to `0` (or unset it) and redeploy; or engage the user kill switch (immediate, no
  redeploy) and use the CORCH-11 pause (`users.corch_paused`) to stop dispatch while keeping the queue.

## Item 10 - optional external producer

- Only if an external producer is configured: mint an `ext:corch` key (explicit scope; NULL keys do not satisfy it)
  and enable `accept_external` per project. No producer ships in v1; skip otherwise. The producer posts to
  `POST /api/ext/corch/work-items` (Bearer `ext:corch` key; body fields `repo_ident`, `source`, `source_ref`, plus
  title and body), a different route from the cookie-auth `POST /api/corch/work-items`.
- Verify: with `accept_external` enabled a post answers 2xx and creates a queued item; with it disabled, or with a
  key lacking `ext:corch`, the same post is refused and creates no row.
- Rollback: disable `accept_external` on the project.

## Live proof procedure (CORCH-R6.6, success criterion 2)

Runs only after items 1-9 for ONE throwaway repo with one slot container and one enrolled project. No real client
repo is enrolled by this phase.

1. Enqueue one small, harmless item on the throwaway project (`POST /api/corch/work-items` or an `ext:corch`
   key; the external route is `POST /api/ext/corch/work-items`). Record the **item id**.
2. Watch `GET /api/corch/queue` (or the live `corch_queue` panel): the item goes `queued` -> `running`. Record the
   **run row** (`corch_runs.id`, `account_slot`, `supervisor_id`, `session_id`, `worktree_path`).
3. The worker commits and pushes branch `corch/<item id>`; the turn ends and `corch.pr_lookup` finds the PR; the
   item becomes `pr_open` with `pr_url`. Record the **PR URL on `corch/<item id>`**.
4. AAF adopts and merges the PR (author is the machine user from item 7). Record the **AAF merge** (merge commit
   sha / PR merged state from `gh pr view`).
5. AAF sends the signed `pr.merged` event; the hub marks the item `done`. Record the **`event_id`**
   (`corch_events.event_id`, `outcome='done'`, `work_item_id`) and the final **hub status `done`**.
6. Evidence rule: take every value from the live system (hub queue API, `corch_runs`/`corch_events` read-only
   queries, `gh pr view`), never from a worker's report. Write them into the phase `VERIFICATION.md`.
7. Also record the A8 observation (next section): did the worker finish under the allowlist, and which Bash
   commands, if any, were refused.
8. Teardown: confirm the worktree was removed and the memlog claim released; set `REMO_CORCH_ENABLED` back to its
   prior value unless the owner decides to continue (that decision is a separate cutover).

Failure handling: do not retry in a loop and do not loosen permissions. Record the exact failing step and error,
file the ticket per the repo rules, and leave `REMO_CORCH_ENABLED` OFF.

## A8: does a worker finish a phase under the per-slot permission allowlist?

Static evidence (code, no live access), gathered in CORCH-12:

- The slot entrypoint (`tools/slot-image/entrypoint.sh`) writes `/data/claude/settings.json` on first start with
  `allow`: Read, Edit, Write, Glob, Grep, `Bash(git:*)`, `Bash(bun:*)`, `Bash(npm:*)`, `Bash(gh:*)`; `deny`:
  `Bash(sudo:*)`. An operator-edited file is never overwritten.
- The hub launches machine sessions with `skipPermissions: false` (`hub/src/dispatch/governed-launch.ts`, HEAL
  policy), and the supervisor honors `dangerously_skip_permissions` only when `allow_dangerous_skip_permissions` is
  true in its config, which `tools/cloud-session/write-config.ts` sets only from `REMO_ALLOW_DANGEROUS=1` (not set
  by the slot image).
- Therefore a slot runs under the allowlist with no silent bypass.

What this does NOT prove: that a real GSD phase needs only those commands. Anything outside the allowlist (for
example `node`, `bunx`, `cargo`, `python`, `mkdir`, `rm`) raises a permission prompt that the headless stream-json
runner is not attended, so such a turn may stall waiting for an answer (the runner can relay a permission request to
a human surface, but no human is watching a slot). Whether it stalls is empirical and can only be settled by the live proof.

Decision recorded: **A8 is DEFERRED to the live proof (PANEL-REQUIRED if it fails).** If the throwaway run stalls
on a permission prompt, the fix is a panel decision on widening the allowlist for the specific commands observed
(edit the per-slot `settings.json`), never enabling `--dangerously-skip-permissions` and never setting
`REMO_ALLOW_DANGEROUS` on a slot.

## CI coverage (success criterion 1)

`hub/test/e2e/corch-full-loop.e2e.test.ts` drives the whole loop on real Postgres with fakes for the AAF sender
(signed events are posted to the real route), memlog, the slot supervisor, the session spawn and the dispatch send
(the turn end is driven by calling the finalize hook the dispatcher registered; the real dispatch gate chain and
send are covered separately by `corch-dispatcher.e2e.test.ts`): happy path to `done` with `event_id`
recorded, death requeue then done, quota wait then run, and `pr.closed` to `blocked`. It runs in
`.woodpecker/qc.yaml` through `bun run orchestrator:e2e` (glob `hub/test/e2e/*.e2e.test.ts`) and `check-baseline`.
