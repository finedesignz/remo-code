# CORCH-00 Research: what CUG and gsd-console expose today

**Date:** 2026-11-13. **Mode:** read-only. **Sources:** `origin/main` of `claude-usage-guard` (CUG, head c0ac0a5, crate 0.8.8) and `gsd-console` (head 803c2e1, API 7.7.0), read via `git show origin/main:<path>`. Live probe of the hosted console. Local read of CUG's own `usage-snapshot.json` (counts and ages only, no emails, no tokens).
**Tags:** `[V: file:line]` = opened this session. `[LIVE]` = checked against a running system this session. `[UNVERIFIED]` = not checked. Paths are under `src-tauri/src/` for CUG unless noted.
**Assumption:** the question is "what can CORCH build on", so I did not read remo-code itself. The hub-side facts come only from gsd-console's docs.

## Summary (load-bearing)

1. **CUG already produces the exact feed CORCH needs, on disk.** After every poll it atomically writes `%APPDATA%\com.titaniumlabs.claude-usage-guard\usage-snapshot.json`, schema `version: 1`. Each entry has `slot`, `email`, `five_h_pct`, `seven_d_pct`, `resets_5h`, `resets_7d`, `fetched_at` and `source` (`live|scope_blind|fetch_failed`). It has no token fields. [V: usage_snapshot.rs:36-98; docs/usage-snapshot-schema.md]
2. **CUG has no outbound publisher and no inbound server.** There is no HTTP POST to any owner service, no `TcpListener`, no MCP. The old `notify` config block was removed. The only consumer is the PowerShell `autonomy/scripts/usage-preflight.ps1`, which reads the file. [V: grep of all `src-tauri/src/*.rs` for listener and post calls, hits only usage.rs:348 (Anthropic) and usage_login.rs:839 (OAuth refresh); config.rs:664 test name for the removed notify block]
3. **Adding a publisher is a small change.** `reqwest 0.12` (blocking, rustls) is already a dependency. [V: Cargo.toml:28] The single production publication seam is the `write_snapshot` closure at `account_commands.rs:1976-1985`, called at `:2073`.
4. **gsd-console is a usable backlog source for read.** Hosted Express + Postgres, push-fed by per-machine connectors and GitHub webhooks, parsed by gsd-core verbs. `GET /api/board/projects` and `GET /api/board/projects/{id}` accept a `gsdc_` bearer token with scope `board:read`, so the hub can call them server-to-server. [V: docs/openapi.json; docs/AUTH.md:88-110] [LIVE] `https://gsd-console.titaniumlabs.us/openapi.json` responds 200 (OpenAPI 3.1.0, v7.7.0, 73 paths). `/healthz` returns `status: ok` with db, board_listener, parser all up.
5. **Gaps that matter:** there is no "next actionable phase" endpoint; which of the ~60 repos are enrolled is UNVERIFIED; the mirror holds no absolute paths; quick-action dispatch (`POST .../actions`) is cookie-only, so the hub cannot dispatch through gsd-console.

---

## Part A. CUG

### A1. How usage per account is fetched

- **Endpoint:** `GET https://api.anthropic.com/api/oauth/usage` (`USAGE_URL`, usage.rs:6). Profile: `/api/oauth/profile` (usage.rs:7). Called by `fetch_usage(token)` with a 30s timeout, `Authorization: Bearer`, header `anthropic-beta`. [V: usage.rs:262-272]
- **Shape parsed:** `five_hour`, `seven_day`, `seven_day_opus` blocks, each with `utilization` and `resets_at`. [V: usage.rs:101-105, 228-240] `Usage` carries `five_hour_pct`, `seven_day_pct`, `opus_pct`, `resets_5h`, `resets_7d`, optional `credits` (extra_usage).
- **Interval:** `poll_interval_secs` default 300 [V: config.rs:198], floor 60 [V: config.rs:299]. The poller is an in-process tokio loop that sleeps `next_poll_delay_secs(...)`. On a 429 it backs off, honoring `Retry-After`. [V: lib.rs:658-777]
- **Who gets polled:** the loop first reads the ACTIVE account (`run_cycle_collect`, commands.rs:720). Then a single-flight background job, `refresh_all_usage_after_engine`, polls every stored account that holds its own app-owned `usage_credential`. [V: lib.rs:719-738; usage_source.rs:1-8 says ONE path, app-owned refreshable credential, never the CLI token]
- **A second, no-network projection** (`project_cached_usage`, account_commands.rs:1954) runs every cycle via `after_poll(&cache_projection, true, ...)`, even when the poll itself failed. [V: lib.rs:745-756] So the snapshot file is rewritten every cycle regardless of upstream health.
- **Per-account data model (`AccountView`, account_commands.rs:134):** `id` (UUID), `label`, `current`, `five_h`, `seven_d`, `opus`, `status`, `stale`, `scope_blind`, `email`, `pass_item`, `resets_5h`, `resets_7d`, `threshold_5h_pct`, `threshold_7d_pct`, `blocked`, `enabled`. `view_of()` is documented as the only construction point, so "nothing secret can cross". [V: account_commands.rs:134-215, doc on `view_of`]
- **Reading freshness:** a cached reading is trusted for `3 x poll_interval` (900s at default), and is dropped once its window's `resets_at` has passed. [V: account_commands.rs:653-655; eligibility.rs:15-26]

**Where stored**
- Account store: `%APPDATA%\com.titaniumlabs.claude-usage-guard\accounts.json` (`ACCOUNTS_FILE`, accounts.rs:37). Config: `config.json` in the same dir (config.rs:2, `config_dir()` at :281). No database.
- Published snapshot: `usage-snapshot.json` in the same dir. Atomic tmp-then-rename. Rust is the sole writer. [V: usage_snapshot.rs:39-40, 178-189]
- Rotation broker files (owned by the PowerShell broker, not CUG): `~/.claude/token-rotation.json` and `token-rotation-state.json`. [V: account_commands.rs:1960-1963]

**[LIVE] Real snapshot right now (local read, no emails printed):** 6 slots. `generated_at` was 232s old. 5 `live`, 1 `fetch_failed`, 0 `scope_blind`. Every `live` entry showed `five_h_pct: null` with a populated `seven_d_pct` (26, 30, 45, 3, 100), and one slot is at 100% 7d. The `five_h_pct: null` on `live` entries is UNVERIFIED as to cause (the API may omit `five_hour` when no 5h window is open). The hub MUST treat `null` per field as "unknown", never 0. The schema doc already says `null`, not `0` or `-1`. [V: usage_snapshot.rs:23-26]

### A2. Eligibility, rotation, hard-stop

- **Auto-switch** (`auto_switch.rs`): the ACTIVE account hands off when 5h or 7d utilization reaches its threshold. Defaults are 95% for both and a 30-minute cooldown. [V: config.rs:163-176, 210-213; auto_switch.rs:1-8] A cross-process lock file `auto-switch.lock` stops double switches. If no candidate takes the handoff it raises `out_of_tokens` and stops; it never kills a session. [V: auto_switch.rs:9-18]
- **Per-account thresholds** (`thresholds.rs`): `threshold_5h_pct` and `threshold_7d_pct` on each stored account. Unset means "no override", not 0%. [V: thresholds.rs:1-35]
- **Eligibility** (`eligibility.rs`): time-derived. A sticky `blocked` record excludes an account only until the window's computable end plus `GRACE_SECS = 120`. [V: eligibility.rs:30] The broker cooldowns come from `token-rotation-state.json`. Unknown usage is never an exclusion, which is the opposite of what CORCH wants (see Pitfall 1). [V: eligibility.rs:41-47 comment "Unknown is never an exclusion"]
- **Hard-stop** (`hard_stop.rs`): marks `BlockedInfo`, then invokes `C:\Users\artic\bin\switch-token.ps1 <label>` per eligible candidate in priority order. It never writes `token-rotation*.json` itself. [V: hard_stop.rs:1-27]
- **Preflight ceiling:** `usage-preflight.ps1` defaults to a 55% effective ceiling (max of 5h and 7d) before an unattended run starts. It is FAIL-CLOSED: a missing or unreadable snapshot, a stale reading, `fetch_failed` and `scope_blind` all return NO-GO (exit 2). The staleness window is 2 x poll interval. [V: autonomy/scripts/usage-preflight.ps1:39-44, 55-57, 77-78] This is a ready-made reference for the hub's own fail-closed rule.
- **Documented hard limit:** a stored, non-active account's usage is only observable if it has its own interactive-login `usage_credential`; a setup-token alone is `scope_blind` forever. [V: thresholds.rs:17-22; usage_snapshot.rs:64-69]

### A3. Existing publish paths and the autonomy subtree

- **Outbound publish:** none. **Local HTTP server:** none. **MCP:** none. (See Summary 2.) The Tauri capability file is `src-tauri/capabilities/default.json` [UNVERIFIED contents].
- **Only existing consumer:** `autonomy/scripts/usage-preflight.ps1`. It runs `claude-token-rotate.ps1 -Get -DryRun -AsJson` to learn which slot the broker would hand out, then reads `usage-snapshot.json` for that slot. It prints a `PREFLIGHT_JSON:` line. It exposes no network surface. [V: usage-preflight.ps1:14-37, 200-201]
- **Other `autonomy/` pieces:** `claude-token-rotate.ps1` (the rotation broker), `claude-run-with-rotation.ps1`, `token-health-check.ps1` (scheduled), `gsd-sentinel.ps1` (reported as a no-op in memory, not re-verified), hooks (`agent-model-guard.mjs`, `agent-spawn-gate.mjs`, `gsd-agent-concurrency-guard.mjs`). The CLAUDE.md of CUG says `autonomy/` is not yet the live deployed copy. [V: CLAUDE.md line 3]
- **Branch `feat/capacity-gate`** (force-updated during my fetch) is a CPU/affinity admission gate for launches, unrelated to quota. Not relied on. [V: `git diff --stat origin/main...origin/feat/capacity-gate` file list]

### A4. How OAuth tokens are stored (mechanism only)

- **Per-user Windows DPAPI**, base64 on the wire: `crypto::encrypt_secret` and `decrypt_secret` (crypto.rs:145, 189). Scope is the current Windows user (flags 0), no extra entropy, so a copied `accounts.json` decrypts nowhere else. [V: crypto.rs header doc]
- `accounts.json` holds, per account, `token_ciphertext` (the setup-token, DPAPI) and an optional `usage_credential` whose access and refresh halves are both DPAPI blobs. [V: accounts.rs:134-146, 179-190, 224-229] `Debug` impls are hand-written to avoid leaking. [V: accounts.rs:163-170, 290]
- The CLI's own credential file `~/.claude/.credentials.json` is read-only to CUG, used for identity only. [V: token.rs:1, usage_source.rs:5-8]
- Rotation slots reference Proton Pass items by name (`pass_item`). That is a name, not a secret. [V: account_commands.rs `pass_item` doc]. CUG already has `pass_cli.rs` for Pass reads [V: file exists in tree; contents not read].
- Interactive login for usage is minted by spawning `claude auth login` under an isolated `CLAUDE_CONFIG_DIR`. [V: usage_login.rs:9-17, 92-95]

### A5. Smallest change to add a publisher

**Recommendation:** new module `src-tauri/src/hub_publish.rs`, hooked at the one production publication seam.

1. In `project_cached_usage()` the closure at `account_commands.rs:1976-1985` builds `build_snapshot_with_read_times(views, read_at)` and calls `write_snapshot_to(...)`. After the file write succeeds, hand the SAME `UsageSnapshot` value to `hub_publish::enqueue(snapshot)`. [V: account_commands.rs:1976-1985] The test-only twin at `:2127` needs no change.
2. `enqueue` spawns on `tauri::async_runtime::spawn_blocking` (the same pattern as `background_refresh::after_poll`), with a single-flight lease so a hung hub never stacks requests. It uses `reqwest::blocking::Client` with a short timeout. It never blocks the poll and never fails the poll (log a warn, like the snapshot write does). No retry queue: the next cycle is the retry, and the hub fail-closes on TTL.
3. **Payload:** `{ "schema": 1, "publisher": "cug", "generated_at", "poll_interval_secs", "accounts": [ { "account_id", "label", "slot", "five_h_pct", "seven_d_pct", "resets_5h", "resets_7d", "fetched_at", "source", "enabled", "blocked", "current" } ] }`. **Drop `email`** (the snapshot has it; `AccountView.label` is user-typed and may itself be an email, so confirm the privacy choice [UNVERIFIED decision]). No tokens exist anywhere in `AccountView`/`SnapshotEntry`, so the narrowing is a field allow-list at one struct.
4. **Config:** two new `config.json` fields, `hub_publish_url` (default off) and a hub credential read from Proton Pass through the existing `pass_cli.rs`, or sealed via `crypto::encrypt_secret`. Do not put it in plain `config.json`.
5. **Heartbeat property for free:** because the projection runs every cycle even when the upstream poll fails (lib.rs:745-756), the publisher posts every cycle. The hub can therefore treat "no POST within ~2 x interval" as CUG down and fail closed. An all-`fetch_failed` payload is a distinct, still-closed state.
6. **Effort:** one new module (~120 lines), one call site, two config fields, a unit test using the existing `finish_cached_refresh_at` injection seam (account_commands.rs:1992), and a doc update to `docs/usage-snapshot-schema.md`. Release path stays the signed-MSI tag flow. [V: CLAUDE.md "Deploy target"]

**Alternative the owner has not chosen:** a supervisor on the same Windows host could relay the existing file with zero CUG change. That contradicts the locked decision ("CUG must PUBLISH"), and I am not recommending it.

---

## Part B. gsd-console

### B6. Architecture, data, freshness

- **Two parts:** a hosted Express 4 facade (`hosted/`, Coolify, `https://gsd-console.titaniumlabs.us`, Postgres with row-level security) and a zero-dependency local **connector** (`connector/src`, no inbound port, outbound long-poll). A legacy local board (`server.js`) is separate and not in the image. [V: CLAUDE.md "Project", "Architecture"]
- **What it mirrors:** the `.planning/` folder of each project. Text files only (`.md .json .yaml .yml .txt`), up to 5000 files and 20 MB per checkout, bodies up to 512 KB. Content-hashed (`file_set_hash`). [V: docs/MIRROR.md "The three feeds", "Hashing"]
- **Three feeds into one project row (key = lowercased `owner/name`):** `connector` (machine checkout; manifest then changed files, debounced 500 ms), `github` (signed push webhook, default branch only), `hook` (a `mirror:write` token from a post-write hook). [V: MIRROR.md]
- **Parsed model:** a separate parser service runs gsd-core verbs (`roadmap.analyze`, `state-snapshot`, `list-todos`, `phase-plan-index`, `verify.plan-structure`) and the console stores one typed snapshot: milestones, phases, plans, tasks, todos, state position. A plan is done when it has a summary. Tasks carry name and type only, no status. [V: MIRROR.md "Parser"; BOARD.md "Columns"]
- **Freshness is push-driven, no polling timers.** Connector push (500 ms debounce), GitHub webhook, parse scheduled 2s after a file-set change. The hosted side fans out with Postgres `LISTEN/NOTIFY`. [V: MIRROR.md "Parser"; BOARD.md "stream"] Staleness flags are computed on read: `stale` when a connector has not been seen for 10 minutes or the snapshot hash differs from the file set. Connector `online` means seen within 45s. [V: MIRROR.md "Stale and divergent flags"]
- **Repos covered:** only checkouts the owner enrolled with the connector (`gsd-console-connector enroll`, then `run`; `remove <dir>` to drop) plus GitHub sources registered by `POST /api/mirror/github/sources`. How many of the ~60 repos are enrolled is **UNVERIFIED** (needs an authenticated read of `GET /api/mirror/projects`). [V: docs/CONNECTOR.md enrollment section]

### B7. HTTP API and auth

Routes below are from the committed `docs/openapi.json`, which matches the live document (v7.7.0, 73 paths). [V + LIVE]

| Need | Route | Credential |
|---|---|---|
| Fleet, one row per project: position (milestone, current phase and plan, status, progress), `snapshot_state`, `stale`, `divergent`, latest run, active runs, `last_activity_at` | `GET /api/board/projects` | cookie or Bearer `board:read` |
| One project: checkouts with flags, `columns` (`done`/`current`/`backlog`/`pending` phases with plans and tasks), milestones, todos, `state`, runs, actions, targets | `GET /api/board/projects/{id}` (`?checkout=`) | cookie or Bearer `board:read` |
| Parsed snapshot of one checkout (`state`: ready/failed/pending/not_configured, `stale`, `snapshot`) | `GET /api/mirror/checkouts/{id}/snapshot` | cookie or Bearer |
| One mirrored file body | `GET /api/mirror/checkouts/{id}/file` | cookie or Bearer |
| Mirror project list with stale roll-up | `GET /api/mirror/projects`, `/{id}` | cookie or Bearer |
| Push stream: first frame `snapshot {projects}`, then a `project` event per change with `board_version`, `stream-error` when its listener is down | `GET /api/board/stream` (`?project=`) | cookie or Bearer `board:read` |
| Runs | `GET /api/runs`, `/runs/{id}`, `/runs/{id}/events`, SSE `/api/runs/stream`; `POST /api/runs/events` (`run:report`) | Bearer |
| Identify a token | `GET /api/token/self` | any valid token |

- **Auth types:** `cookieAuth` (the `__Host-gsdc_session` cookie, set after a Titanium magic-link exchange; writes need an exact `Origin`) and `bearerAuth` (machine token `gsdc_` + 43 base64url, stored as sha256, shown once). Scopes: `board:read`, `board:write`, `run:report`, `command:pull`, `mirror:write`. Failures: 401 `invalid_token`/`token_revoked`, 402 `entitlement_required` (account without a plan), 403 `insufficient_scope`. [V: docs/AUTH.md:88-125]
- **Server-to-server from the remo hub: YES for reads.** A `gsdc_` token with `board:read` works with `Authorization: Bearer`. Tokens can only be minted from a browser session (`POST /api/tokens`, a token cannot mint tokens), so there is one owner step to mint it, then store it in Proton Pass. Limits: 120 req/min per token, 600/min per client address on `token/self`. [V: AUTH.md "Machine tokens"] Prefer the SSE stream over polling, but note: max 10 open streams per account, 500 per process, 10-minute lifetime then reconnect with a fresh snapshot (BOARD.md "Limits"). [V]
- **Writes the hub cannot make through gsd-console:** `POST /api/board/projects/{id}/actions` (quick actions such as `next`, `autonomous-on`) is "a browser session only ... no machine token can issue an action". [V: docs/ACTIONS.md:38] Cloud launch (`POST /api/cloud/sessions`) and local launch (`POST /api/local/sessions/{id}/launch|stop`) do accept Bearer (`board:write` for local). [V: openapi.json; LOCAL.md]
- **MCP facade:** `mcp__claude_ai_MCP_Factory__gsd-console` (a proxy at `apps/gsd-console` in `mcp-servers`, generated from the OpenAPI document). Tools: `list_projects`, `get_project_board`, `list_runs`, `get_run`, `list_run_events`, `report_run_event`, `list_project_actions`, `check_auth_status`. Read and report only. [V: docs/MCP.md] I could not read the `mcp-servers` side (`git rev-parse origin/main` failed in that checkout) [UNVERIFIED].

**The existing remo-code link (gsd-console to hub):**
- The console stores ONE remo-code API key per account, sealed AES-256-GCM under `GSDC_SECRETS_KEY`, shown only as a fingerprint, never returned. Key shape `remokey_...` or `remo_...`; verified by one hub read before storing. [V: docs/LOCAL.md "Linking a remo-code key"]
- Hub routes it uses: `GET /api/ext/sessions` (read, scope `ext:read`), plus launch and stop behind the explicit `ext:launch` scope. Hub answers: 202 `{launching, run_id}`; 200 `{stopped}`; 409 refusals `already_online`, `use_orchestrator_start`, `supervisor_offline`, `supervisor_ambiguous`, `no_project_dir`, `automation_halted`; 429 `at_capacity {running, cap}`. [V: LOCAL.md "The hub contract"]
- The join key is the project slug: the hub's repo id `github://owner/name`, lowercased, equals the console slug `owner/name`. The hub's absolute `project_dir` is dropped at the client boundary and never stored. [V: LOCAL.md]
- Consequence for CORCH: the hub already exposes `ext:launch`, `automation_halted` and `at_capacity` semantics that CORCH should reuse or align with. I did not read remo-code to confirm they are on its `main` [UNVERIFIED].

### B8. Verdict: reuse vs. read `.planning` directly

**Reuse gsd-console as the backlog READ source.** Do not reimplement the parser in the hub.

Use:
- `GET /api/board/projects` for the fleet scan and ordering (`position.milestone`, `position.phase`, `position.status`, `snapshot_state`, `stale`, `divergent`, `last_activity_at`, `active_runs`).
- `GET /api/board/projects/{id}` for phase lists (`columns`) for a project the fleet scan flagged.
- `GET /api/board/stream` (Bearer `board:read`) as the change trigger, so the hub re-reads only the changed project. No timer polling (global rule 23).

Keep in the hub, not gsd-console:
- **Dispatch.** Use the hub's own `ext:launch` path or the supervisor. gsd-console cannot dispatch for a machine token.
- **Slug to working directory.** The mirror stores no absolute path. The supervisor or hub project table must map `owner/name` to a checkout.
- **Quota gating.** Unrelated to gsd-console; it comes from the CUG feed.

**Gaps (each is a CORCH task or a ticket):**
1. **No "next actionable phase" endpoint.** The `next` verb is a Claude skill (`gsd-next`) run in a session, not an API. [V: ACTIONS.md:11] The hub must derive it from `columns`: the `current` phase, else the lowest-numbered `pending` phase; ignore `backlog` (phase number starts `999`); skip when a project has `active_runs > 0` or `stale`/`divergent`. [V: BOARD.md "Columns" rules] There is no dependency or "blocked" signal beyond `state` and `todos` (field content not inspected).
2. **Coverage unknown.** The mirror only knows enrolled checkouts and registered GitHub repos. A repo outside both is invisible. Needs an authenticated `GET /api/mirror/projects` against the ~60-repo list (not done: no token, and I must not mint one).
3. **Freshness and truth.** A connector feed reflects the owner machine's working tree (uncommitted work included); a GitHub feed is the default branch only. A connector offline more than 10 minutes marks the checkout `stale`. The hub must fail closed on `stale` or `divergent` for dispatch decisions, not route around it. [V: MIRROR.md]
4. **Task status is not invented.** A task is done only when its plan has a summary. Plan-level progress only.
5. **Mirrored text is untrusted.** The API docs say so. Phase names, todos and state text are prompt-injection input to any agent the hub spawns; never interpolate them into prompts unescaped. [V: openapi.json descriptions on the board routes]
6. **Entitlement coupling.** The Titanium plan must stay active for the account; an unentitled account gets 402 on Bearer calls. [V: AUTH.md]
7. **Token mint is a browser-only owner action** (one-time, scope `board:read`). Store in Proton Pass; rotation needs owner approval (global rule 7f).
8. **No fallback (rule 7c).** If gsd-console is down or returns 5xx, the hub should fail closed and ticket it; do not fall back to direct `.planning` reads, which would give a second, divergent backlog truth.

**When direct supervisor reads win:** only if CORCH must act on uncommitted `.planning` changes faster than the connector's 500 ms plus parse debounce, or for repos the owner will not enroll. That is a non-goal today.

---

## Pitfalls for the plan

1. **CUG treats unknown usage as eligible; the hub must not.** `eligibility.rs` states "Unknown is never an exclusion". The hub's gate must be the opposite: per-account `null` figures or `source != "live"` means no headroom. `usage-preflight.ps1` is the reference behavior (NO-GO unless `-Force`).
2. **`five_h_pct: null` on `live` entries is real today** (5 of 5 live slots in the local file). Decide the hub rule before coding: recommend treating a `live` entry with `five_h_pct == null` as "5h unknown" and gating on 7d plus a configured 5h reserve, then confirm against `usage.rs` and a live API response. [UNVERIFIED cause]
3. **Two time bases.** `generated_at` is the poll time; `fetched_at` is per-account; `resets_*` are ISO strings from Anthropic. The hub should fail closed on the snapshot (`received_at` older than ~2 x `poll_interval_secs`) AND on per-account `fetched_at` age, mirroring CUG's own 3 x interval trust window.
4. **CUG not running means no feed.** The tray app is the only publisher. A hub TTL is the only protection, so build the TTL first.
5. **Do not put `email` in the feed unless the owner wants it.** `SnapshotEntry.email` exists; `label` may also be an email.
6. **CUG's only-writer rule:** nothing but the Rust app may write `usage-snapshot.json`. A publisher that reads the in-memory `UsageSnapshot` is within the rule.
7. **gsd-console stream limits:** 10 streams per account and a 10-minute lifetime. The hub needs reconnect-with-fresh-snapshot, not a long-lived assumption.

## Overlap found in the remo-code CLAUDE.md (not verified in code)

From `remo-code-corch-planning/CLAUDE.md` (cited, I did not open the files):
- The hub already has its own subscription-quota path: the supervisor polls Anthropic with the token in `~/.claude/.credentials.json` every 5 min (`supervisor/src/usage/oauth-poll.ts`), and the hub keeps an in-memory snapshot (`hub/src/usage/store.ts`) shown in the web `UsageStrip`. That is a second quota source next to CUG. It reads the active CLI credential only, so it cannot see the other accounts. The CORCH plan needs an explicit decision: the dispatcher gate reads ONLY the CUG-published feed, and the old store stays display-only. [UNVERIFIED: whether anything gates on it today]
- A hub-side auto-dev orchestrator already exists, default OFF (`REMO_ORCHESTRATOR_ENABLED`, `hub/src/orchestrator/`), with a daily token cap (20M, all four buckets), an inject-rate gate, a kill switch and a lifetime inject cap. CORCH should extend or replace these, not add a parallel dispatcher.
- The hub exposes `/api/ext` with scoped API keys (`ext:read`, `ext:ask`, explicit-only `ext:work`). A CUG publish endpoint needs its own explicit-only scope, for example `quota:publish`, so a leaked CUG key cannot read sessions.

## Errors and tickets

No service errors hit (the live probes succeeded). One non-service note: `git -C mcp-servers rev-parse origin/main` returned "Not a valid object name origin/main" (that checkout's default branch name differs or the ref is absent); I skipped the MCP-proxy-side read rather than retry. No AAF ticket filed (not a failure of a service or tool I depend on).
