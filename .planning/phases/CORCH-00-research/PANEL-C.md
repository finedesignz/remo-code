# CORCH panel seat C: security + operations (refute-first)

Evidence read: PANEL-BRIEF, RESEARCH-remo, RESEARCH-cug-gsdconsole, RESEARCH-aaf (leads, not re-verified in code; no tool calls beyond reads). Tags: [R]=RESEARCH-remo, [C]=RESEARCH-cug-gsdconsole, [A]=RESEARCH-aaf.

## F1. Dispatcher core

**Verdict:** REPLACE. New cross-repo work-item queue (`corch_*` tables, additive in schema.sql). Reuse only `dispatch()` gates, `governedLaunch`/`launchSessionForUser(machine:true)`, `reserveSessionSlot`, ledger, kill switch. Leave the macro orchestrator flag OFF and untouched until the retire phase.

**Rationale:**
- The macro path is a per-session heartbeat: the agent re-reads its own STATE.md; the hub has no work-item identity, so idempotency, reclaim and "no dropped work" (R3) cannot be expressed [R:0, R:1]. `routine_queue` is keyed by session with one running cycle per session [R:1].
- The extended path has never produced a real PR in prod (PTYCAP P5 "never once happened") [R:1]. Building on it inherits an unproven security surface.
- New dispatch path must satisfy the guards: new counter-key kind `corch:<work_item_id>` added to the `counter-key-assignment-guard` allowlist, kill-switch gate FIRST on the gate list, cost + token caps in every `gates: [...]` (`token-cap-coverage`), launch only via `governedLaunch` (`launch-callers-guard`) [R:4, R:12].
- Lifetime cap 1000 per key is a non-issue per work item (a key per item bounds each item's retries).

**Strongest counter:** EXTEND is less code and already carries the caps/kill switch. Loses because every control worth keeping is in `dispatch/` and `governedLaunch`, which REPLACE reuses; what EXTEND adds is only the per-session heartbeat that cannot model a backlog, and it would put new security-relevant state into rows whose semantics (agent-reported `<<STATE>>` sentinels, [R:1]) are self-reported by the agent.

**Risk:** Two dispatchers coexisting. Mitigation: guard test that CORCH and `REMO_ORCHESTRATOR_ENABLED` are mutually exclusive at boot (refuse to boot with both ON), and all CORCH dispatch fails closed on any gate error (no dispatch-anyway branch, same as the heal seam invariant).

## F2. Backlog storage + ingestion

**Verdict:** Hub Postgres tables are the system of record for work items, owner priority and per-project budget. gsd-console (`board:read`, SSE stream) is the ONLY feed for "what phase is next". No supervisor `.planning` reads.

**Rationale:**
- Priority/budget are owner decisions and must be authoritative and auditable in the hub, not derived from mirrored repo text [C:B8].
- Two readers of `.planning` (console + supervisor) = two divergent truths; C:B8.8 already says fail closed when console is down, no direct-read fallback (rule 7c).
- Mirrored text is untrusted [C:B8.5]: the dispatched prompt is a fixed template parameterized only by validated values (repo ident from allowlist, integer phase number). Phase names/todos never enter the prompt; run through `fenceUntrusted` if ever shown.
- `stale`/`divergent`/`active_runs>0` = not dispatchable [C:B8.3].
- AAF tickets and memlog requests enter through ONE authenticated endpoint with a new explicit-only scope `ext:corch`. Items carry `source` and land at a priority ceiling below owner items; free text fenced; repo must be in the (default-EMPTY) allowlist, else 403 before any row. Same shape as the `work_repo_allowlist` gate.

**Strongest counter:** Supervisor-direct reads avoid the third-party dependency and token. Loses because the console already parses (gsd-core), pushes on events (no polling, rule 23), and the only "win" (uncommitted `.planning` faster than 500ms) is a stated non-goal [C:B8]. Also a supervisor reading arbitrary repo files is a wider trust surface than a single `board:read` token.

**Risk:** `gsdc_` token is a long-lived credential minted only via browser. Keep it read-only (`board:read`), store in Pass and Coolify secret env, never log; rotation only with owner approval (7f). 10-minute SSE lifetime and 10-stream cap require reconnect-with-snapshot logic, test it. Coverage of the 60 repos is UNVERIFIED; unenrolled repos are invisible (fail closed = not dispatched).

## F3. Quota feed

**Verdict:** CUG POSTs to a new hub endpoint (`POST /api/corch/quota`) with an explicit-only scope `quota:publish` key. AAF reads `GET /api/corch/quota` with a separate explicit-only `quota:read` key. Hub fails CLOSED. Hub-observed 429/rate-limit events are authoritative negative evidence.

**Rationale:**
- One seam in CUG (`account_commands.rs:1976-1985`), publishes every cycle even when the upstream poll fails, so absence of POSTs = CUG down = block [C:A5]. A supervisor relay adds a second hop and a second writer to the safety-critical feed.
- Snapshot has no tokens; drop `email` [C:A5.3]. Different scopes for publish and read so a leaked AAF read key cannot forge quota and a leaked CUG key cannot read sessions.
- A forged feed is the real threat: attacker with the publish key could report 0% and induce overspend. Controls: scoped key, TLS, `generated_at` strictly monotonic per publisher and within +-5min of hub clock (reject replay/skew), values range-checked, and the hub's own daily token cap + inject-rate gates stay as independent ceilings [R:4]. Bearer over TLS is sufficient; HMAC over the body adds little over a bearer key already covering the same hop.
- TTL: snapshot `received_at` <= 2x poll interval (600s) AND per-account `fetched_at` <= 3x poll (900s) (CUG's own trust window) [C:Pitfall 3]. `source != live` (`scope_blind`, `fetch_failed`) = no headroom [C:Pitfall 1]. Hub-side display store `hub/src/usage/store.ts` stays display-only; the gate must never read it (it fails OPEN, no staleness check) [R:3].
- Null: `five_h_pct == null` on a `live` entry is "5h unknown", never 0. Eligible only if `seven_d_pct` is known and under the machine ceiling (55%, matching `usage-preflight.ps1`) AND at most 1 concurrent session on that account. Treating null as blocked would stall the whole fleet today (5 of 5 live slots are null [C:A1]); treating null as 0 is the unsafe direction. Cause of null is UNVERIFIED: verify against a live API response in the quota phase, before cutover.
- 429 observed by any CORCH session on account X blocks X until `resets_at` regardless of feed.

**Strongest counter:** Supervisor forwarding needs zero CUG release (CUG ships via signed MSI). Loses because owner locked CUG as the publisher, the supervisor is not guaranteed alive on the CUG host, and it would put quota truth behind a component whose own liveness is what we fail closed on.

**Risk:** CUG needs a new signed MSI to publish; until then the hub feed is empty and the dispatcher dispatches nothing (correct). The publish key sits on the owner's desktop (read from Pass via `pass_cli.rs`, not plain `config.json`) [C:A5.4]; compromise = quota forgery only.

## F4. Linux worker (R4)

**Verdict:** One supervisor container PER ACCOUNT SLOT (6 containers), each holding exactly one `CLAUDE_CODE_OAUTH_TOKEN` as a Coolify runtime-secret env var. Each registers to the hub as its own supervisor (`purpose='host'` key) carrying an opaque `account_slot` label; the hub selects an account by selecting that supervisor. The token never transits or is stored in the hub. Per-container `CLAUDE_CONFIG_DIR` volume, per-container repo volume, per-work-item `git worktree`. Desktop supervisors get NO per-account injection in v1 and are never targets of CORCH dispatch (no `account_slot` label = account unknown = fail closed).

**Rationale:**
- Refuting the obvious option (one worker holding 6 env tokens): the CLI child and its agent run arbitrary shell as the same uid and can read the supervisor's `/proc/<pid>/environ` (or sibling env), so one prompt-injected session exfiltrates all 6 accounts. One token per container reduces blast radius to one account and removes any need for the supervisor to select/inject secrets.
- Hub-pull-per-dispatch violates the "token never in hub" requirement. Pass-at-boot needs an authenticated Pass session on the server, i.e. a master credential unlocking every secret, a worse blast radius than six scoped tokens.
- Account choice reuses existing machinery: `reserveSessionSlot` is already per-supervisor concurrency [R:4], and `claude-runner.ts` needs no per-run env injection (tokens are set at container start, not per dispatch). Child env must still be built from an allowlist, not inherited `process.env`, and `ANTHROPIC_API_KEY` scrubbed [R:2].
- Worktrees: the supervisor never runs `git worktree add` [R:7]; Linux host runs Bun source directly so a new command needs no MSI. Worktree per work item (`../repo-<slug>`) isolates concurrent sessions in one repo; removal on merged/closed event.

**Strongest counter:** Per-session ephemeral container is stronger isolation (repo vs repo, not only account vs account). Loses on cost and privilege: spawning containers needs a docker socket (root-equivalent) inside the worker. Residual: sessions within one slot share a filesystem. Accept, and mitigate with restricted egress (Anthropic, GitHub, package registries only), a fine-grained GitHub credential, and no deploy credentials in env (extend `scrubDeployCredentials` use) [R: CLAUDE.md work invariants].

**Risk:** Prompt injection from repo content or AAF/memlog text steering an agent to exfiltrate its one token; egress allowlist is the control. Coolify at-rest encryption of env values is UNVERIFIED. Owner must mint 6 setup tokens (interactive OAuth consent); a setup-token account is `scope_blind` for CUG usage observation [C:A2], so the Windows CUG must hold a separate `usage_credential` per account or the feed will say `scope_blind` and block (fail closed). Two hosts burning one account's quota is visible to CUG through the account's own usage, so no double-counting problem.

## F5. PR identity + AAF closure

**Verdict:**
- **Identity:** a dedicated machine user (GitHub account, org team with write, fine-grained PAT: contents + pull-requests only; no admin, no workflow, not in any branch-protection bypass list). NOT the owner account. GitHub App bot is the better long-term identity but AAF's trusted-author check (`getCollaboratorPermissionLevel`) is UNVERIFIED for bots [A:1.5]; revisit after CORCH ships.
- **AAF adoption:** BOTH, in sequence. `POST /api/projects/provision` is mandatory (no project row = webhooks ignored, no merge) [A:2.2]. `POST /api/pr-adoptions` is required for red-CI ownership [A:1.6].
- **Outbound event:** AAF outbox + `signedPost`, header `X-ZeroExposure-Signature: sha256=HMAC(secret, body)`, body carries stable `event_id` and a fresh `timestamp` per send. Hub receiver: raw body before JSON parse, constant-time compare, reject >5min skew, dedupe on unique `event_id`, mounted before the `/api/*` catch-all with `mount-order` test updated.
- `pr.closed` unmerged IS an event.

**Rationale:**
- Owner account on a server container = a token with the owner's reach across ~60 repos and AAF attributes merges to it [R:memory]. A machine user bounds the credential and gives an auditable actor.
- Real exposure to flag: AAF merges any same-repo write-collaborator PR on green CI with REVGATE skipped [A:2.1]. A compromised or injected CORCH agent can get auto-merged if CI passes. Controls: AAF destructive-diff + CI-config denylist already exist; adopt-time check that the PR author is in an allowlist `CORCH_TRUSTED_AUTHORS` and head repo == base repo (so a leaked CORCH key cannot make AAF push to arbitrary PRs; the fixer has push credentials), and `ext:corch`-style explicit scope `pr:adopt`.
- The signed string covers a body-embedded timestamp rather than the hub's `${ts}.${rawBody}` form; equivalent security if the hub enforces skew on the signed `timestamp` field plus event_id dedupe. Alternative is a header timestamp, which means changing the shared signer; not worth it. Separate secret per direction; the hub secret lives in Coolify env, rotation only with owner approval.
- `pr.closed` unmerged: otherwise the work item sits `pr_open` forever (violates R3). Hub sets `pr_closed` and does NOT auto-requeue (a human may have closed it deliberately); owner sees it in the status view. `pr.failed` (fix cap/escalation) sets `needs_attention`, never auto-redispatches the same item.
- Receiver must be public https:443 (AAF `vetOutboundUrl`) [A:3.3]. AAF is unreachable-safe: its outbox retries; hub sets a `pr_open` heartbeat deadline that ALERTS the owner on expiry (no GitHub polling, no auto-redispatch).

**Strongest counter:** Owner account is simplest (merge trust verified today) and no new account to manage. Loses because the blast radius of a server-resident owner token is the largest in the system and the machine-user write-collaborator path is the same verified code path [A:1.5]. The App-bot alternative loses only on being unverified.

**Risk:** Owner must create the machine user and add it to an org team across 60 repos, and ensure the org is in `AUTOMERGE_OWN_GITHUB_ORGS` (empty refuses all) [A:2.1]. `ai-review` sweep gap (merge-policy.md:39) can stall repos that require that check [A:2.5]; ticket AAF side. Whether `pull_request closed` reaches the hook for repos with no project row is UNVERIFIED [A:3.2]; provision-before-first-PR makes it moot.

## F6. Phase order (one phase = one PR in one repo)

1. **CORCH-01 remo-code: backlog + dispatcher core.** `corch_work_items` (+ priority, per-project budget, idempotency key `repo+phase+attempt`, states incl. `quota_deferred`, `pr_open`, `pr_closed`, `needs_attention`), claim/heartbeat/reclaim, counter-key kind + guard update, gate list (kill switch first, cost, token), governedLaunch only, mutual-exclusion boot guard vs old orchestrator, quota provider interface returning "unknown" = refuse. Flag OFF. Manual enqueue API under `ext:corch`. Paired repos: none.
2. **CORCH-02 remo-code: quota ingest + gate.** `POST/GET /api/corch/quota`, scopes `quota:publish`/`quota:read`, per-account store, 2x/3x TTL, null rules, 429 negative evidence, account-eligibility for dispatch. Must precede CUG.
3. **CORCH-03 claude-usage-guard: `hub_publish.rs`.** Single seam, allow-listed fields, key from Pass, signed MSI. Depends on 02.
4. **CORCH-04 remo-code: gsd-console feed.** `board:read` token, SSE with reconnect, next-phase derivation, stale/divergent/active-run skips, untrusted-text rules, allowlist.
5. **CORCH-05 remo-code: AAF event receiver.** HMAC + skew + event_id dedupe, mount-order test, `pr.merged/closed/failed` state transitions, heartbeat-deadline alert. Must precede AAF sender.
6. **CORCH-06 agentautofix: outbox + events** (`orchestrator_event_outbox`, `signedPost`, hooks at the merged branch and escalation sites) **and quota read** (`quotaFeed.ts` -> `pauseFixClaimsUntil`, feed-down = pause). Depends on 02 and 05.
7. **CORCH-07 agentautofix: `POST /api/projects/provision` + `POST /api/pr-adoptions`** with author allowlist, scope `pr:adopt`. Independent of 06, may parallel.
8. **CORCH-08 remo-code: PR hand-off closure.** Calls provision before first PR in a repo and adoption after each PR; item lifecycle tied to events. Depends on 05, 07.
9. **CORCH-09 remo-code: Linux worker (R4).** Per-slot container image, headless supervisor, `account_slot` label + dispatch only to labeled supervisors, worktree command, env allowlist, egress allowlist, deploy-credential scrub, runbook. Depends on 01, 02.
10. **CORCH-10 remo-code: status view + remote control.** Queue panel (reuse AutoDevActivityPanel pattern), pause/priority via API, Telegram `/queue`, `fanOutNotify` alerts; retire the old orchestrator path (update guard tests, no behavior change to flag-OFF default). Depends on 01-08.
11. **CORCH-11 remo-code: canary + cutover.** Throwaway repo end to end (absorbs PTYCAP P5 proof), then one allowlisted real repo. Owner-gated flag flips.

**Owner actions at cutover (verified-live checks first, per rules 1c/12b):**
- Mint scoped hub keys: `quota:publish` (CUG), `quota:read` + `pr:adopt`-side keys (AAF), `ext:corch` (AAF/memlog bridge), 6 `host` supervisor keys.
- Mint the `gsdc_` `board:read` token (browser-only).
- Generate 6 setup-tokens (OAuth consent) into Pass and Coolify per-slot secrets; confirm CUG holds a usage credential per account.
- Create the machine user, org team write, PAT; confirm AAF GitHub App installed and org in `AUTOMERGE_OWN_GITHUB_ORGS`.
- Check prod `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` before any deploy (CLAUDE.md warning); confirm old orchestrator flags OFF.
- Flip order: quota feed live -> status view -> worker -> dispatcher on throwaway repo -> allowlist real repos one by one. Each flip that starts real unattended spend is a live cutover (rule 12).
