---
phase: 12-ui-restructure
reviewed: 2026-05-28T00:00:00Z
depth: deep
files_reviewed: 83
findings:
  blocker: 6
  high: 8
  medium: 9
  low: 4
  info: 3
  total: 30
status: issues_found
---

# Phase 12 UI Restructure — Adversarial Code Review

Scope: `git diff origin/main..feat/ui-restructure-and-dry-pass` (83 files / +5647 / −2284). Six commits, c64b29f..39f8a3d. Focus: correctness, security, license-gate parity, CSRF, step-up auth, deep-link redirects, WS resource use, and unrelated-regression hunting in the `Wave 5 cleanup` commit.

## Blockers

### BL-01: Multiple parallel WebSocket connections opened on every authenticated render — risks hitting per-IP cap (20)

**File:** `web/src/pages/HomePage.tsx:38`, `web/src/pages/TasksPage.tsx:36`, `web/src/pages/SettingsPage.tsx:55`, `web/src/components/ChatLayout.tsx:49`, `web/src/App.tsx:213`, `web/src/components/GridPage.tsx:48`

**Issue:** `useWebSocket(token)` opens a fresh WS each invocation (it manages its own `wsRef`, no module-level singleton). On the Home route a single browser tab now mounts: (a) `NotificationsBridge` (App.tsx), (b) `HomePage`, (c) `ChatLayout` (inside HomePage when tab=list) or `GridPage` (when tab=grid). That is 3 concurrent `/ws/client` sockets per Home page render. On Tasks/Settings it drops to 2 (NotificationsBridge + page). Each authenticates independently, fires `auth_ok`, and counts against the hub's per-IP connection limit (20, per `CLAUDE.md`). Two browser tabs on Home = 6 sockets per IP — three tabs trips the cap and silently breaks the next user's tab. Also: `HomePage` and `SettingsPage` request `subscribe` but only pass it down to `HeaderRight → UsageStrip`, while `ChatLayout`/`GridPage` open the canonical subscribe used by chat — the page-level WS is effectively wasted bandwidth + DB load (auth re-runs `getUserLicenseFields`, etc.).

**Fix:** Lift `useWebSocket` to a single React context provider at App.tsx and have all consumers (`HomePage`, `TasksPage`, `SettingsPage`, `ChatLayout`, `GridPage`, `NotificationsBridge`) read `useWebSocketContext()` from it. One socket per browser tab.

---

### BL-02: License gate on WebSocket mutations was removed — expired/banned users can still `send_message`

**File:** `hub/src/ws/client.ts` (entire `LICENSE_GATED_WS_TYPES`/`isLicenseActive` block removed; data fields `licenseStatus`, `licenseCheckedAt` deleted)

**Issue:** Phase 07-D explicitly added a license check on WS-mutating messages (`send_message`, `permission_response`, `question_response`) to mirror the HTTP gate. Wave 5 cleanup deleted that gate wholesale with no replacement. Users with `license_status='expired'` / `suspended` / `banned` can now fully drive Claude/Codex sessions through the WS while the HTTP gate locks them out. This is a regression of Phase 07-D's parity invariant ("mutating WS messages refuse when status !== 'active'", per `CLAUDE.md`'s Phase 07 section). The deletion is not mentioned in any commit message and there is no replacement check anywhere in `client.ts`.

**Fix:** Restore the `LICENSE_GATED_WS_TYPES` set, `isLicenseActive()` helper, and the per-message gate. Keep the cached-license + 60s TTL pattern. Add a regression test (the deleted `hub/test/ws-client-license-gate.test.ts` covered exactly this).

---

### BL-03: send_message dedupe layer removed — duplicate prompts now reach Claude on client retry

**File:** `hub/src/ws/client.ts` (deletion of `checkDuplicate`/`recordSend` calls), `hub/src/ws/send-dedupe.ts` (deleted binary), `hub/test/send-message-dedupe.test.ts` (deleted)

**Issue:** Phase 07-X added 5-min TTL dedupe keyed on `(session_id, client_msg_id)` so an `inFlightRef` replay during reconnect would replay the original ack rather than re-injecting the prompt into Claude's stdin. The client's `useWebSocket.ts` still maintains `inFlightRef` and still replays unacked messages on reconnect (see `INFLIGHT_STORAGE_KEY` rehydration on line ~95). With dedupe gone, every reconnect-replay now creates a fresh `messages` row and re-sends the prompt to the runner. User-visible symptom: phantom duplicate user turns + double cost on flaky networks. Tests for this behavior (`send-message-dedupe.test.ts`) were also deleted in Wave 5.

**Fix:** Restore `send-dedupe.ts`, the `checkDuplicate`/`recordSend` calls in `send_message`, and the regression test. The client-side `inFlightRef` retry contract REQUIRES server-side idempotency.

---

### BL-04: `findOrCreateAgentSession` lost its atomic ON CONFLICT — concurrent agent reconnects can dup-insert sessions

**File:** `hub/src/db/dal.ts:166`

**Issue:** Reverted from atomic upsert (`INSERT ... ON CONFLICT (user_id, project_dir) WHERE deleted_at IS NULL AND is_rootless = false DO UPDATE`) to read-then-insert. The supporting partial unique index `idx_sessions_user_project_unique` was simultaneously dropped from `schema.sql` (entire "TRIAGE Bundle 6" block deleted). Two concurrent supervisor reconnects for the same `project_dir` now race and produce duplicate `sessions` rows — exactly the failure mode Bundle 6 fixed. The deletion is in the Wave 5 commit with no migration / discussion in the phase plan.

**Fix:** Restore the partial unique index AND the `ON CONFLICT DO UPDATE` upsert. Restore `hub/test/db-ordering.test.ts` and `hub/test/finalize-open-runs.test.ts` (also deleted in Wave 5). Add a phase note explaining why orchestrator removal motivated removing the index — there is no such justification; the orchestrator deletion is unrelated.

---

### BL-05: messages.seq column dropped + ORDER BY no longer disambiguates same-ms inserts

**File:** `hub/src/db/dal.ts:489` (ORDER BY `m.created_at ASC` only — `m.seq ASC` removed); `schema.sql` (the `ALTER TABLE messages ADD COLUMN seq BIGSERIAL` block deleted)

**Issue:** Same-millisecond inserts (common when Claude emits assistant text immediately after a tool result) will now sort non-deterministically, producing scrambled transcripts on session reload. The `seq` column was added in TRIAGE Bundle 6 specifically to fix this. The Wave 5 cleanup dropped both the column and its ORDER BY usage.

**Fix:** Restore the column and the secondary sort. If the migration concern is the BIGSERIAL backfill cost, gate behind `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (it already was). There is no upside to removing this.

---

### BL-06: `idleTimeout: 255` removed from `Bun.serve` — long-running fan-out endpoints will 502 again

**File:** `hub/src/index.ts:322`

**Issue:** Phase 06 added `idleTimeout: 255` with a detailed comment explaining that Bun's 10s default kills HTTP requests whose WS round-trip exceeds 10s — notably `POST /api/supervisors/:id/scan` (20s budget) and `/clone` (300s). Coolify's Traefik surfaces the early termination as 502. Wave 5 deleted the field + the explanatory comment with no migration note. `PATCH /api/supervisors/:id/roots` (newly added this phase) uses a 5s timeout — safe — but `scan`, `clone`, and `dispatchTriageStub` paths will regress to 502s.

**Fix:** Restore `idleTimeout: 255` and the comment. This is a direct undo of a production-stability fix.

## High

### HI-01: `PATCH /api/users/me/prompts` not gated by `requireRecentAuth`

**File:** `hub/src/api/supervisors.ts:337`, `hub/src/index.ts:265`

**Issue:** The Prompts tab persists `claude_global_md`, `codex_agents_md`, and `codex_config_toml`. These blobs are seeded into the supervisor's filesystem on next `auth_ok` (per Phase 05 "Instructions sync"). An attacker who steals a session cookie (XSS, etc.) can drop arbitrary instructions into the user's CLAUDE.md / AGENTS.md / config.toml — that is a code-execution primitive on the supervisor host because the user's Claude sessions will follow those instructions. The original PUT /api/instructions route did not have step-up either, but the new endpoint widens reach without adding a gate. The review prompt explicitly required `requireRecentAuth` here.

**Fix:** Wrap `/api/users/me/prompts` (PATCH) in `requireRecentAuth()` via `app.use('/api/users/me/prompts', async (c, next) => isMutating(c) ? requireRecentAuth()(c, next) : next())` in `hub/src/index.ts`.

### HI-02: `PATCH /api/users/me/profile` not gated by `requireRecentAuth`

**File:** `hub/src/api/supervisors.ts:374`

**Issue:** Accepts `notifications` (JSONB) and `avatar_url` (data URI). The endpoint is mounted on `usersMe` and shares the same broad lack of step-up. Per phase prompt: profile editing was listed in the requireRecentAuth set. Stolen-cookie attacker can also flip notifications channels (e.g., redirect email digests via webhook config if the schema later supports it).

**Fix:** Same as HI-01 — add `requireRecentAuth` middleware for the prompts + profile mutating routes.

### HI-03: `PATCH /api/supervisors/:id/roots` not gated by `requireRecentAuth` despite supervisor-fs reach

**File:** `hub/src/api/supervisors.ts:218` (comment explicitly says "No requireRecentAuth — low-risk")

**Issue:** Setting roots causes the supervisor to scan and expose new repos to the hub. Combined with the lack of supervisor-side path validation (HI-04 below), this is a privilege-escalation primitive on the supervisor host. The "low-risk" comment is wrong — roots determine what code Claude can execute against.

**Fix:** Add `requireRecentAuth()` for PATCH `/api/supervisors/:id/roots`.

### HI-04: `validateRoots` allows arbitrary absolute paths; supervisor blindly writes them

**File:** `hub/src/lib/roots-validate.ts`; `supervisor/src/hub-client.ts:onSetRoots`

**Issue:** The hub validator rejects `..` traversal but accepts any absolute path — e.g. `C:\Windows\System32`, `/etc`, `/root/.ssh`. The supervisor's `onSetRoots` then writes these into supervisor.json verbatim and re-scans, exposing those filesystems' git repos (if any) to the hub UI. There is no allowlist, no user-confirmation prompt on the supervisor, and no length-limit per-root-string check on the supervisor side (only on hub). A compromised hub or a user with a hijacked cookie can point supervisor scan at sensitive directories.

**Fix:** Have the supervisor (a) refuse roots outside a configurable whitelist (defaulting to `%USERPROFILE%`, `$HOME`), (b) re-validate every root with its own validator (defense in depth), (c) require user confirmation via Tauri dialog when a root is added that isn't already in `RootsPanel`'s current state.

### HI-05: `setSupervisorRoots` DAL writes a JS string array directly into PG without explicit cast

**File:** `hub/src/db/supervisor-dal.ts:178`

**Issue:** `SET roots = ${args.roots}` — postgres.js will infer parameter type from inspection. If `supervisors.roots` is `TEXT[]` (likely), this works; if it's JSONB, this silently coerces to a string array literal that may parse-fail on read. There is no test asserting the column type. Compare to the careful `text[]→boolean[]` cast pattern in `upsertPendingLocalRepoBatch` — same file, same author, much more cautious.

**Fix:** Add `::text[]` cast: `SET roots = ${args.roots}::text[]`. Add a unit test that writes roots then reads them via `getSupervisor` and asserts shape.

### HI-06: GitHub-issue post-run lost its placeholder-claim race-prevention

**File:** `hub/src/scheduler/post-run/github-issue.ts:166`

**Issue:** The placeholder-claim pattern (`placeOpenIssuePlaceholder` + `update` on success + `delete` on failure) narrowed the race window where two concurrent failure webhooks for the same `(repo, app_uuid, deploy_uuid)` both passed `hasOpenIssueForHash` and then both called `octokit.issues.create`. The Wave 5 cleanup deleted the three DAL functions and the placeholder logic, leaving a dead `void hash` statement. Two concurrent failure webhooks (Coolify retries on 5xx are common) can again produce duplicate issues. Deleted test `hub/test/github-issue-idempotency.test.ts` covered this.

**Fix:** Restore the placeholder dance and the test. Or, if the dance is genuinely unwanted, replace with `INSERT ... ON CONFLICT DO NOTHING RETURNING` before the octokit call.

### HI-07: `ClientSendMessage` content `.trim()` removed — leading/trailing whitespace now persisted and re-sent

**File:** `hub/src/ws/protocol.ts:17`

**Issue:** `content: z.string().min(1).max(1_000_000)` (was `.trim().min(1)`). A message of pure whitespace `"   "` now passes the `min(1)` check, gets persisted to `messages`, and is forwarded to the runner. Wastes daily-cost-cap budget and bloats history.

**Fix:** Restore `.trim()` or add an explicit `.refine(s => s.trim().length > 0, "empty content")`.

### HI-08: `'skipped_quota'` status removed from `ScheduledRunFinished` enum — runtime broadcasts will fail zod validation

**File:** `hub/src/ws/protocol.ts:100`

**Issue:** The enum was narrowed from `['pending','in_flight','running','success','failed','skipped','skipped_quota','cancelled']` to drop `'skipped_quota'`. `scheduler/dispatcher.ts` `enforceCostCap` still emits `skipped_quota` (used by `recordSkippedRun`). Any client subscribed to `scheduled_run_finished` WS event will see a zod parse error on the hub side and the event will be silently dropped — Tasks → Activity tab will miss quota-skip rows until next refresh. Confirm by grepping `scheduler/dispatcher.ts` for `skipped_quota`.

**Fix:** Re-add `'skipped_quota'` to the enum, or rip out every emitter — but it is an in-use status.

## Medium

### ME-01: WS `subscribe_error` schema change breaks the existing "at least one session_id required" contract

**File:** `hub/src/ws/protocol.ts:39`

**Issue:** The refine changed from `!!d.session_id || Array.isArray(d.session_ids)` to `!!d.session_id || (Array.isArray(d.session_ids) && d.session_ids.length >= 0)`. The new condition `length >= 0` is tautologically true for any array — so an empty-array subscribe now passes. That subscribes to nothing AND counts against the per-connection 12-session cap with a 0-entry set. The original (`Array.isArray`) was also too permissive but at least the intent was clear.

**Fix:** Tighten to `(Array.isArray(d.session_ids) && d.session_ids.length > 0)`.

### ME-02: Deep-link redirect rewrites `#/grid/:tabId` but the new URL drops the WS-subscribe semantics for that tab

**File:** `web/src/App.tsx:54` (`resolveHashWithRedirects`)

**Issue:** `#/grid/abc` → `#/?tab=grid&grid_tab=abc`. `getGridTabId()` then parses `grid_tab` and forwards to `<GridPage tabId={...}>`. So far so good — but the redirect happens at module load (line 43, runs at import time when `window.location.pathname !== '/'`) AND in `getRoute()` on every call. Calling `replaceState` inside a render-derived `getRoute()` is a side-effect-during-render anti-pattern; React StrictMode will double-invoke it. The redirect is OK at module-load but the `useEffect`-less `getRoute()` invocation in `useState(() => getRoute())` runs in render.

**Fix:** Move the redirect logic into `useEffect` on mount only, OR keep it but make it idempotent (it appears idempotent but the replaceState call still fires unnecessary history mutations).

### ME-03: `readTabParam` strips fragment after `#` — false-positives for tabs containing literal `#` in encoded form

**File:** `web/src/lib/ui/nav.ts:38`

**Issue:** `hash.split("?")[1]` then splits on `&`. If a tab value contains an encoded `&` (unlikely but valid), `decodeURIComponent` produces wrong parses. Low impact — current tab names are hardcoded.

**Fix:** Use `new URLSearchParams(hash.split("?")[1] || "")`.

### ME-04: Activity-tab `hasMore` check has a logic bug — `length === PAGE_SIZE && !!next_cursor` denies legitimate end-of-list

**File:** `web/src/pages/tasks/ActivityTab.tsx:96`

**Issue:** If the page is exactly `PAGE_SIZE` items and the server returns no `next_cursor` (final page that happened to fill), `hasMore` becomes `false` — correct. But if there are exactly `PAGE_SIZE` items remaining and server DOES return cursor, then load-more fetches an extra page with 0 items but `hasMore` stays true on the previous render until the empty fetch completes. Minor UX, not a correctness bug.

**Fix:** Rely on `!!next_cursor` alone.

### ME-05: Avatar data-URI size limit `1.4MB` is enforced on the base64 string length, not decoded bytes

**File:** `hub/src/api/supervisors.ts:399`

**Issue:** `v.length > MAX_AVATAR_BYTES_PROFILE` checks the base64-encoded string size. Decoded image is ~1MB at the limit. That's fine as a cap, but the error message says `avatar_too_large` with `max_bytes: 1_400_000` — users will be confused when their 1MB JPG is rejected (because base64 inflates ~33%). Also: no MIME-bomb check on decoded content (an attacker can craft a base64 that decodes to a 100MB SVG — but extension regex limits to png/jpe?g/gif/webp so SVG is blocked).

**Fix:** Either rename the field to `max_encoded_bytes` or check `Buffer.from(b64, 'base64').length` for true byte size.

### ME-06: `sumUserCostWindows` SQL: `AT TIME ZONE ${tz}` injection surface if tz validation skipped

**File:** `hub/src/db/dal.ts:768`

**Issue:** `tz` is parameterized (postgres.js tag), so injection is blocked at the protocol layer. However, `AT TIME ZONE` requires a `text` literal, and PG will error if `tz` is invalid (this is fine — caller validated via `Intl.DateTimeFormat`). Concern: the query joins `scheduled_for >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}` — this is mismatched. The standard pattern is `(now() AT TIME ZONE 'UTC' AT TIME ZONE ${tz})` to normalize. As written, `now() AT TIME ZONE ${tz}` converts to wall-clock in tz, truncates to day, then `AT TIME ZONE ${tz}` converts back to UTC — that DOES work (postgres does both operations as `timestamp <-> timestamptz`), but only if `scheduled_for` is `timestamptz`. If it's `timestamp` (no tz), comparison silently uses session tz.

**Fix:** Verify `scheduled_task_runs.scheduled_for` column type. If `timestamp without time zone`, comparison is wrong. Add a unit test with explicit tz boundaries.

### ME-07: `listUserActivityRuns` returns raw `r.*` — leaks internal columns to clients

**File:** `hub/src/db/dal.ts:805`

**Issue:** `SELECT r.*, t.name AS task_name, t.task_type` exposes every column on `scheduled_task_runs`, including potentially sensitive operator-only fields (e.g., raw stdout snippets, error stack traces). The Activity tab UI consumes a narrow subset. This is information disclosure to the user (not cross-user, since user_id filter is correct) but still leaks internals (raw error strings, internal timing data, etc.) that may include third-party tokens if a run logged them.

**Fix:** Select an explicit column list. Strip `output_snippet`, `error_full`, etc. unless deliberately exposed.

### ME-08: `notifications JSONB NOT NULL DEFAULT '{}'::jsonb` accepts arbitrary depth/structure with no schema

**File:** `hub/src/db/schema.sql` (Phase 12 block); `hub/src/api/supervisors.ts:367`

**Issue:** `z.record(z.unknown())` lets a user post arbitrarily deep, large JSON. With `max(100_000)` not applied to this field, the JSONB can grow unbounded subject to PG's `1GB` field limit. A malicious or buggy client can OOM the row. Also: no schema means future readers will need defensive parsing.

**Fix:** Define a concrete zod schema for the supported notification channels (web_push, email_digest, telegram) and reject unknown keys with `.strict()`. Add a body size limit.

### ME-09: `stripSecretLines` regex on `codex_config_toml` is line-scoped; multi-line TOML values bypass it

**File:** `hub/src/api/supervisors.ts:330`

**Issue:** `SECRET_LINE_RE = /^\s*(api[_-]?key|apikey|token|secret|password)\s*=/i` only matches when the secret name appears at start of line followed by `=`. TOML allows `[section]` heading where the value is on the next line, or `api_key = """\nmulti-line\nvalue\n"""`. The regex catches the `api_key =` opener line but not the subsequent value lines — so the key is removed but the value content remains in the file. Also, TOML inline tables (`foo = { api_key = "bar" }`) won't match at all. Strip is best-effort but advertised by the comment as enforcing security.

**Fix:** Either parse as TOML and strip semantically, or document the regex as "obvious-pattern only, not security boundary".

## Low

### LO-01: Supervisor `VERSION` was decremented `'0.5.6' → '0.5.5'`

**File:** `supervisor/src/hub-client.ts:12`

**Issue:** Comment says "Keep in sync with `supervisor/tauri/src-tauri/tauri.conf.json` version". Need to verify tauri.conf.json was also dropped to 0.5.5 — if not, the in-memory VERSION conflicts with the bundled MSI version. Per project rule #14, version bumps go up not down.

**Fix:** Confirm tauri.conf.json matches; if intentional rollback, document why. Otherwise restore to next version (e.g., 0.5.7).

### LO-02: `useEffect` in tabs has stale-closure risk with `subscribe` prop unused for live updates

**File:** `web/src/pages/tasks/UpcomingTab.tsx:55`, `ScheduleTab.tsx:62`, `ActivityTab.tsx:72`

**Issue:** Each tab accepts `subscribe` but never registers a handler for `scheduled_run_finished` / `scheduled_task_changed` events. The tab data goes stale until the user navigates away and back. Effectively a missed-feature, not a bug — the API is one-shot fetch.

**Fix:** Wire `subscribe` to setState on relevant events, OR remove the unused prop and the wasted WS connections in HomePage/TasksPage/SettingsPage (see BL-01).

### LO-03: `cache.get(userId)` in `usage.ts` keyed only by userId — timezone changes don't invalidate

**File:** `hub/src/api/usage.ts:35`

**Issue:** If user changes timezone via `PATCH /api/users/me/profile`, the cached cost windows still reflect the old tz for 60s. Minor: user toggles timezone rarely.

**Fix:** Include tz in cache key, OR clear cache on profile update.

### LO-04: `console.warn` removed from license-gate without replacement metric

**File:** `hub/src/license-gate.ts:152`

**Issue:** The `[license-gate] refresh failed; serving cached status=...` warning was the only signal that Titanium API was flaking. Wave 5 removed it silently. Operators now have no visibility into TitaniumApiError frequency.

**Fix:** Restore the log line, or replace with a counter/metric.

## Info

### IN-01: Worktree filter (PR #98 descent guard) — file not modified, untouched

**File:** `supervisor/src/repo-scanner.ts`

**Result:** `git diff origin/main..HEAD -- supervisor/src/repo-scanner.ts` shows no changes. Descent guard intact.

### IN-02: Wave 5 deletes large amount of working test coverage with no replacement

**Files (deleted in Wave 5):** `hub/test/db-ordering.test.ts`, `finalize-open-runs.test.ts`, `github-issue-idempotency.test.ts`, `orchestrator-prompt.test.ts`, `orchestrator.test.ts`, `post-run-github-issue.test.ts`, `send-message-dedupe.test.ts`, `send-message-validation.test.ts`, `upsert-pending-local-repos.test.ts`, `ws-client-license-gate.test.ts`, `ws-protocol-cluster.test.ts`, `supervisor/test/claude-runner-env.test.ts`

**Result:** Tests deleted include the regression coverage that would have caught BL-02, BL-03, BL-04, BL-05, HI-06. Several of these correspond to live behavior still in the codebase (e.g., send-message-validation, db-ordering for messages.seq if restored). Treat the deletion list as an audit checklist — anything not orchestrator-specific should be restored.

### IN-03: Documentation does not reflect new endpoints

**File:** `docs/openapi.json`, `docs/api.md` (not in diff)

**Issue:** `CLAUDE.md` API-docs convention requires `bun run docs:sync` to be run when new routes land. `/api/tasks/*`, `/api/usage/summary`, `/api/users/me/prompts`, `/api/users/me/profile`, `/api/supervisors/:id/roots` are not in the OpenAPI spec dump. CI workflow `docs-drift.yml` should be failing this PR.

**Fix:** Migrate these five routes to `createRoute` in `_openapi.ts` or document explicit waiver.

---

## Summary

| Severity | Count |
|----------|-------|
| Blocker  | 6     |
| High     | 8     |
| Medium   | 9     |
| Low      | 4     |
| Info     | 3     |
| **Total**| **30**|

**Key themes:**
1. **Wave 5 cleanup is hostile** — it deleted at least 5 production-stability fixes (license gate, WS dedupe, atomic upsert, messages.seq, idleTimeout, github-issue race fix) along with their tests, all under the cover of an "orchestrator removal" commit. None of those concerns are orchestrator-related. This commit needs a focused review and most deletions should be reverted.
2. **Step-up auth missing on the new sensitive endpoints** — prompts (supervisor-fs reach), profile, and roots (supervisor-fs reach) all need `requireRecentAuth`.
3. **WS connection explosion** — 3 concurrent `/ws/client` per Home tab will breach the per-IP cap quickly.
4. **Schema regression** — partial unique index + seq column removal will resurface race + ordering bugs the codebase had previously paid to fix.

_Reviewed: 2026-05-28_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
