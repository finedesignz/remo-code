# CORCH panel seat B - scope/reuse lens (refute-first)

Evidence: PANEL-BRIEF.md, RESEARCH-remo.md (R), RESEARCH-cug-gsdconsole.md (C), RESEARCH-aaf.md (A). One spot-check done: claude-usage-guard origin/main `src-tauri/src/usage.rs` ~L225-240 (parse of five_hour).

## F1. Dispatcher core

**Verdict:** NEW repo-keyed work-item queue reusing only dispatch primitives. Do NOT extend `runMacroCycle`/`routine_queue`/orchestrator rows. Leave `hub/src/orchestrator/` untouched (flag OFF) until the final retire phase.

**Rationale**
- Orchestrator is session-keyed: one task per session, `idx_routine_queue_session_running`, agent self-reports state via `<<STATE>>` sentinels reconciled next tick (R s1, macro-cycle.ts:357). A cross-repo backlog has no session to key on, and "agent says what it did" is the opposite of a dispatcher that owns state.
- Reuse list is already clean: `dispatch()` gates (inject.ts:269-276), `governedLaunch` -> `launchSessionForUser` (launch.ts:84-254), `reserveSessionSlot`, ledger, kill switch, `fanOutNotify`, `task-macros.ts` prompt text (R s13).
- Needs: new counter-key kind `corch:<work_item_id>` (update `counter-key-assignment-guard` allowlist), gate list with cost + token caps (token-cap-coverage), and a dispatcher-side `ensure sessions row for repo` step (launch.ts:122-131 needs an existing row with project_dir; whether inventory auto-creates rows is UNVERIFIED, so the dispatcher calls `createSession` itself, api/sessions.ts:147).

**Strongest counter:** "Extend: smaller diff, tick/queue/stale-lock reaper/notify already e2e-tested in CI."
Loses because: (a) the e2e-tested path has never produced a prod PR (ROADMAP.md:131 "never once happened"), so reuse inherits an unproven loop, not a proven one; (b) bending a session-keyed schema to repo-keyed items means touching the PTYCAP-owned tables/guards (R s12) with more blast radius than an additive `corch_*` set; (c) the 60s tick is a polling loop, banned by rule 23 where an event exists (SSE + AAF webhook + quota publish are all events).

**Risk:** two dispatchers in one hub. Mitigate: `REMO_CORCH_ENABLED` default OFF and mutually exclusive with `REMO_ORCHESTRATOR_ENABLED` at boot (refuse boot if both ON). Retire phase deletes the orchestrator only after the CORCH proof run passes. Counter-key lifetime cap is a literal count (CLAUDE.md): per-work-item key bounds it naturally; also cap attempts per item.

## F2. Backlog storage + ingestion

**Verdict:** hub Postgres tables fed ONLY by gsd-console (`GET /api/board/projects` for fleet, `/{id}` for columns, `GET /api/board/stream` as the change trigger). No supervisor `.planning` reads. Owner priority and per-project budget live in the hub, never in gsd-console.

**Rationale**
- Parser already exists, push-fed, content-hashed (C s6, B8); reimplementing it in the hub is the largest avoidable diff. Reading `.planning` from the supervisor = a second, divergent backlog truth (C B8 gap 8; rule 7c no fallback).
- Tables (additive, schema.sql): `corch_projects(repo_ident PK, enabled, priority int, daily_token_budget, preferred_account null, paused)` = owner-controlled; `corch_work_items(id, repo_ident, milestone, phase, source, status, not_before, attempts, claimed_by, heartbeat_at, branch, pr_url, last_error)` unique `(repo_ident, milestone, phase)` for idempotent upsert; `source` enum gsd|manual (aaf/memlog reserved, not implemented in v1).
- Next-actionable derivation in the hub: `current` phase else lowest `pending`; skip `backlog` (999), `active_runs>0`, `stale`, `divergent` (C B8 gap 1,3).
- AAF tickets / memlog requests: NOT in v1. They are not phase backlog; adding intake adapters now is scope creep. A manual-create API row (`source='manual'`) covers one-offs.

**Strongest counter:** "gsd-console is a hosted dependency of a dispatcher; supervisor-local read is faster and works offline."
Loses because: dispatcher already fails closed on any upstream outage by design, a second path violates 7c, and local reads cannot see non-enrolled checkouts' truth any better; the mirror's 500ms debounce is irrelevant for a work cadence of hours.

**Risk:** enrollment coverage of the ~60 repos is UNVERIFIED (needs authenticated `GET /api/mirror/projects`; token mint is an owner browser step, scope `board:read`, then `pass-set`). Stream limits (10/account, 10-min lifetime) need reconnect-with-snapshot. Mirrored text is untrusted: never interpolate phase names/todos raw into prompts (use `fenceUntrusted`). 402 entitlement coupling. Missing mapping slug -> project_dir: the hub holds it in `corch_projects`/sessions, not gsd-console.

## F3. Quota feed

**Verdict:** CUG POSTs (new `hub_publish.rs` at account_commands.rs:1976-1985) to a new hub endpoint `POST /api/quota/snapshot` with an EXPLICIT-only scope `quota:publish` (cannot read sessions, cannot launch). Hub keeps latest snapshot per account id (in-memory like `usage/store.ts`; restart = fail closed until next publish, <=5 min). AAF reads via `GET /api/quota/snapshot` with explicit-only `quota:read`, called at claim time (not a timer). Drop `email` from the payload.

**Rationale**
- CUG already projects every cycle even when upstream fails (lib.rs:745-756), so publishing every cycle gives a free heartbeat; hub TTL turns silence into fail-closed (C A5.5).
- Supervisor-forward needs a supervisor change (new signed MSI) AND a CUG file path coupling AND duplicates per host; CUG POST needs one CUG release and has a single publisher.
- Freshness: closed when `received_at` older than 2x `poll_interval_secs` (default 600s) OR per-account `fetched_at` older than 3x (900s, CUG's own trust window, C A1). `source != live`, `blocked`, `enabled=false` = no headroom.
- Null rule (spot-checked): `usage.rs` maps an absent `five_hour` window or null utilization to a sentinel that surfaces as `null`; resets_5h is then also null. So `five_h_pct==null && resets_5h==null && source==live` = no open 5h window, treat 5h as 0 for gating; `seven_d_pct==null` = unknown = CLOSED; `five_h_pct==null` with non-null `resets_5h` = unknown = CLOSED. Ceiling on max(5h,7d) reuses CUG preflight's 55% default as `REMO_CORCH_QUOTA_CEILING_PCT`. Treating null as a hard close would stall all 5 live slots today (C s34), so this rule is the minimum that is both fail-closed and usable; mark "confirm against one live API response" as a P2 acceptance check, not an owner question.

**Strongest counter:** "Supervisor relays the file: zero CUG change, no new credential in CUG."
Loses because: supervisor already needs a signed-MSI release for account injection anyway but that is a different phase; coupling quota freshness to supervisor uptime adds a failure mode, the server (Linux) worker has no CUG file, and AAF still needs the hub endpoint. The credential cost (one scoped key via `pass-get` read in CUG's existing `pass_cli.rs`) is small.

**Risk:** CUG tray down = no feed = nothing dispatches (intended, TTL first). AAF per-account mapping is UNVERIFIED (which CUG account the AAF worker token is): AAF gating v1 uses the feed as "any eligible account under ceiling" -> `pauseFixClaimsUntil`, not per-account, to avoid a mapping prerequisite. Old `usage/store.ts` stays display-only; add a guard test that dispatch never reads it.

## F4. Server-side Linux worker

**Verdict:** One headless supervisor container on Coolify (cloud-session-style Bun source, no tray/ConPTY), sessions as subprocesses inside it. Tokens as Coolify secret env per slot (`CORCH_SLOT_<label>_TOKEN`, populated once from Proton Pass by the owner-approved path), read only by the supervisor at spawn. Hub chooses the account and sends ONLY `account_id` in the `session.start` frame; supervisor maps id -> env `CLAUDE_CODE_OAUTH_TOKEN` for that child (extend `claude-runner.ts:162-166` and `env-sanitize.ts`). Token never transits the hub.

**Rationale**
- Hub picks from the quota feed intersected with accounts the target supervisor advertises in `supervisor.hello` (slot labels only).
- Single shared `CLAUDE_CONFIG_DIR`: resume-by-project_dir depends on transcripts in the config dir, so per-account config dirs would break resume across accounts. The OAuth env var supplies identity.
- Checkout strategy v1: one canonical clone per repo under the server root, dispatcher enforces max 1 active item per repo (so no worktrees needed on a machine with no humans). `git worktree add` stays out of scope (supervisor never creates them, R s7).
- Windows desktop supervisor: gets the same code path (inert without slot env) but CORCH never targets it in v1; its canonical checkouts are shared with the owner and other sessions (rule 20 collisions).

**Strongest counter:** "Proton Pass at boot is the actual source of truth and avoids duplicating six tokens into Coolify env; per-dispatch pull from hub is more rotation-friendly."
Loses because: pass-cli on a server needs its own login credential (one more secret, interactive-OAuth risk, a boot-time dependency), and a hub pull makes the hub a token broker, violating the locked constraint. Env is the same at-rest exposure as boot-fetched-in-memory for a single-tenant container, with fewer moving parts. Rotation needs owner approval anyway (7f), after which `coolify` MCP updates env + redeploy.

**Risk:** six tokens in one container; any agent session on it can read sibling slot env, so spawn env must be built from `{}` plus the one token (as AAF `buildChildEnv` does, A containment.ts:301-318) and `sanitizeSpawnEnv` must strip all `CORCH_SLOT_*` from children. Setup-token vs interactive credential: CUG notes setup-tokens are `scope_blind` for usage, fine because usage comes from CUG on Windows. Git push credential on the server is a separate secret (see F5). Linux parity of the headless path is UNVERIFIED; P-linux must run it before anything depends on it.

## F5. PR identity + AAF closure

**Verdict:** PRs authored by the OWNER account (same-repo `corch/<work_item_id>` branch). Merge: hub calls new AAF `POST /api/projects/provision` (existing `provisionReposCoreWith`, scope `projects:write`) once per enrolled repo. Red CI: AAF adopts PRs BY CONVENTION (head ref `corch/*`, same-repo, trusted write author, provisioned project) instead of a hub-called `POST /api/pr-adoptions`. Outbound: AAF outbox event table + `signedPost`, events `pr.merged`, `pr.closed` (unmerged), `pr.failed`.

**Rationale**
- Owner account provably passes `isTrustedAuthorPr` (autoMergeAfterReview.ts:93-110); bot/App behavior is UNVERIFIED, machine user means 60 collaborator invites. Branch prefix + PR label distinguishes orchestrator PRs.
- The hub cannot call adoption "right after opening" because the agent opens the PR inside the session and the hub does not know the PR number. AAF already receives `pull_request` webhooks for provisioned repos, so convention-based adoption removes a hub->AAF round trip, an idempotency story and a forgotten-call failure. Keep existing cap `CI_FAILURE_RESUME_MAX` + `defect_escalated` as the terminal signal.
- Event delivery: reuse `signedPost` (one signer), header `X-ZeroExposure-Signature: sha256=hex(HMAC(secret, body))`, body carries stable `event_id`, fresh `timestamp`, `repo_slug`, `head_ref`, `pr_number`. Hub receiver = new `runIntake` config mounted before auth (constant-time, raw body first, 5-min skew, dedupe on `event_id`), per CLAUDE.md webhook invariant and mount-order test. Hook sites: +server.ts:872-884 (merged), :886-888 (closed unmerged, currently a deliberate no-op), woodpeckerFailureIntake escalation + qcCapMerge/mergeBlockNotice (failed).
- `pr.closed` unmerged IS an event: without it a human-closed PR strands the work item in `pr_open` forever (violates R3). Hub maps head_ref -> work item and requeues or marks `abandoned`.

**Strongest counter:** "Explicit `POST /api/pr-adoptions` is more testable and auditable than implicit convention."
Loses because: it needs a PR number the hub does not have, adds a second write surface to AAF, and a missed call silently leaves a PR with no CI owner. Convention failure is loud-able (AAF logs `corch_adopted`) and the same-repo + write-author checks stay the trust boundary.

**Risk:** (1) AAF design changes at ciFailureClassify.ts:64-68 `pr_context_unsupported` and an unresolved requirement for an active `plugin_apps` row in INFRA-01 (ciFailureIntake.ts:156-194): adopted-PR branch must key on `projects` only; panel/AAF-QC must confirm. (2) `merge-policy.md:39` sweep gap: repos requiring `ai-review` as a required check can stall; enroll only repos without that requirement until AAF fixes it (AAF-side ticket). (3) Repos need the AAF GitHub App installed and org in `AUTOMERGE_OWN_GITHUB_ORGS`; provision route must refuse otherwise. (4) Migration number 0175 must be re-checked against open PRs. (5) Owner-account git credential on the server is broad; use a fine-grained token limited to enrolled repos, owner approval for any mint (7f).

## F6. Ordered phases (one phase = one PR in one repo; first = backlog + dispatcher core)

| # | Repo | Phase | Depends |
|---|------|-------|---------|
| 1 | remo-code | CORCH-01 backlog tables (`corch_projects/work_items/runs`) + dispatcher core: manual item API, priority, concurrency cap, per-project daily token budget, claim/heartbeat/reclaim, requeue-on-death/quota (`not_before`=`resets_at`), `corch:<id>` counter key + guard updates, gates, flag `REMO_CORCH_ENABLED` OFF, mutual-exclusion with orchestrator flag. Quota provider is an interface, default "no snapshot" (fails closed) | none |
| 2 | remo-code | CORCH-02 quota ingest: `POST/GET /api/quota/snapshot`, explicit scopes `quota:publish`/`quota:read`, freshness TTL, null rules, per-account selection into dispatcher | 1 |
| 3 | claude-usage-guard | CORCH-03 `hub_publish.rs` + config + schema doc, signed MSI release | 2 (contract) |
| 4 | remo-code | CORCH-04 gsd-console ingest: SSE client with reconnect+snapshot, next-phase derivation, stale/divergent fail-closed, untrusted-text fencing | 1 |
| 5 | agentautofix | CORCH-05 `POST /api/projects/provision` + convention adoption of `corch/*` red-CI PRs | none (parallel with 1-4) |
| 6 | agentautofix | CORCH-06 outbound event outbox (`pr.merged`, `pr.closed`, `pr.failed`) via `signedPost` | 5 |
| 7 | agentautofix | CORCH-07 `quotaFeed.ts` -> `pauseFixClaimsUntil` at agentRunner.ts:2207 | 2 |
| 8 | remo-code | CORCH-08 AAF inbound webhook (`runIntake`, mount-order test), work-item closure transitions, call provision on enrollment | 1, 6 |
| 9 | remo-code | CORCH-09 supervisor account injection: `supervisor.hello` slot advertisement, `session.start` `account_id`, env build in `claude-runner.ts`, env-sanitize strip of `CORCH_SLOT_*` (signed MSI required for Windows, inert there) | 2 |
| 10 | remo-code | CORCH-10 Linux headless supervisor image + Coolify app, slot secrets, per-repo canonical clone bootstrap, git credential | 9 |
| 11 | remo-code | CORCH-11 status view (extend `AutoDevActivityPanel`), remote pause/priority endpoints, Telegram `/queue` | 1 |
| 12 | remo-code | CORCH-12 end-to-end proof on a throwaway repo (due -> PR -> AAF merge -> event -> item done) + enable runbook; absorbs PTYCAP-05's unproven loop | 2,4,8,10 |
| 13 | remo-code | CORCH-13 retire overlapping flag-OFF code (orchestrator macro path, merge-command, boot mutual-exclusion) | 12 passed |

Notes: 2/4/5 parallelizable after 1; no phase enables a flag in prod (12 produces the runbook; flip is a live-cutover gate). Every phase ships its own docs + `bun run docs:sync` + baseline re-measure.
