# PLAN — Error Capture

Sentry-style intake on the remo-code hub, routed into the user's live Claude CLI session for that repo. Replaces the standalone `claude-code-self-heal` service.

Tasks are fine-grained, one commit each. `[P]` = safe to run in parallel after deps land. Match scheduled-tasks PLAN.md style.

---

## Wave 1 — Foundations (sequential)

### T1. Schema + migration
**Files:** `hub/src/db/schema.sql`
- Add `error_projects`, `errors`, `error_runs` tables (columns per CONTEXT.md "Schema sketch"). Use `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (existing pattern).
- Check whether `notifications_sent` already exists (added by scheduled-tasks). If not, add it with columns `(id UUID PK, kind TEXT, dedupe_key TEXT, sent_at TIMESTAMPTZ DEFAULT now())` and unique constraint `(kind, dedupe_key, date_trunc('day', sent_at))`.
- Indexes from CONTEXT.md "Schema sketch" → Indexes section.
- All statements idempotent.

**Done when:** `bun run dev:hub` boots and `migrate.ts` applies cleanly twice in a row.

### T2. DAL — error_projects + errors + error_runs `[P]`
**Files:** `hub/src/db/error-capture-dal.ts` (new)
- `createProject(userId, { name, sessionId })` — generates `sentry_key`.
- `listProjects(userId)`, `getProject(id, userId)`, `getProjectByKey(sentryKey)`, `updateProject(id, userId, fields)`, `deleteProject(id, userId)`.
- `insertError(projectId, { fingerprint, error_type, error_value, stacktrace_json, release, dispatch_status, error? })` → returns row.
- `markErrorDispatched(errorId, runId)`, `markErrorSkipped(errorId, reason)`.
- `dedupeRecentError(projectId, fingerprint, windowSeconds)` — boolean.
- `countDispatchedLastHour(projectId)`, `countDispatchedToday(projectId)`.
- `insertRun(...)`, `updateRunStatus(...)`, `getRun(id, userId)`, `listRunsForProject(projectId, userId, { limit, before })`.
- `noteNotificationSent(kind, dedupeKey)` — used by daily-summary gate.

### T3. Envelope + auth-header parser + fingerprint `[P]`
**Files:** `hub/src/error-capture/envelope.ts` (new), `hub/src/error-capture/sentry-auth.ts` (new), `hub/src/error-capture/fingerprint.ts` (new)
- Lift `envelope.ts` from `claude-code-self-heal/src/sentry/envelope.ts` verbatim.
- Lift `sentry-auth.ts` from `claude-code-self-heal/src/sentry/auth.ts`: parses `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<k>, ...` → `{ sentry_key, sentry_version, sentry_client }`.
- Lift `fingerprint.ts` from `claude-code-self-heal/src/fingerprint.ts` verbatim (the `normalize()` + `fingerprint()` pair).

**Done when:** Unit tests for each (added later in W6) can import and exercise the functions in isolation.

### T4. Intake route shell
**Files:** `hub/src/api/sentry-intake.ts` (new), wired in `hub/src/index.ts`
- `POST /api/sentry/:project_id/envelope/`. No auth middleware — public endpoint.
- Read raw body as `Buffer` (Hono `c.req.arrayBuffer()`).
- Parse `X-Sentry-Auth`; if missing or bad → `401`.
- `getProjectByKey(sentry_key)` → must match `:project_id` and be `enabled` → `401` otherwise (silent — match Sentry behavior).
- Parse envelope; pick the first `type=event` (or `type=error`) item. If none → `200` with empty body (Sentry SDK expects 200 on accept).
- Defer actual recording to `recordError()` (T5) — for now, log and return `200 { id: <event_id> }`.

**Done when:** A `curl` of a hand-crafted gzipped envelope to `/api/sentry/<id>/envelope/` with the right key returns 200 and logs the parsed event.

---

## Wave 2 — Intake + gating (sequential after Wave 1)

### T5. `recordError` pipeline
**Files:** `hub/src/error-capture/record.ts` (new)
- `recordError({ project, eventPayload, releaseHint })`:
  1. Run `event-mapper.ts` → `{ error_type, error_value, top_frames, stacktrace_json, release }`.
  2. Compute `fingerprint(project.id, error_type, error_value, top_frames_joined)`.
  3. Gates in order: `disabled` → `skipped_disabled`; `dedupeRecentError` hit → `skipped_dedupe`; `countDispatchedLastHour >= rate_limit_per_hour` → `skipped_rate_limit`; `countDispatchedToday >= daily_dispatch_cap` → `skipped_cap`.
  4. Insert `errors` row with the resolved `dispatch_status`. On non-skip → status `pending`.
  5. If `pending` → call `dispatcher.dispatch(errorRow, project)` (T7).
  6. If skipped with summary-worthy reason (`cap`, `rate_limit`, `offline`) → enqueue daily-summary email via `notifyDailySummary(project)` (T8).

### T6. Event mapper
**Files:** `hub/src/error-capture/event-mapper.ts` (new)
- Adapt `claude-code-self-heal/src/sentry/mapper.ts` — strip GitHub-attribution fields.
- Input: raw event JSON. Output: `{ error_type, error_value, top_frames: string[], stacktrace_json: unknown, release: string | null }`.
- `top_frames`: walk `exception.values[0].stacktrace.frames`, reverse (Sentry stores callee-first → we want top-of-stack-first), take 8, format each as `"  at <function> (<filename>:<lineno>)"`.

### T7. Silent-skip → summary email integrator
**Files:** `hub/src/error-capture/notify.ts` (new)
- `notifyDailySummary(projectId)`: gated by `notifications_sent` with `kind='error_cap_summary'` and `dedupe_key=<projectId>:<utc_date>`. If already sent today → no-op.
- On first hit of the day: load yesterday-via-now() skip counts per reason, render an email (use the same `template.ts` from scheduled-tasks post-run? No — keep it simple here; inline a small renderer), send via `hub/src/scheduler/post-run/email.ts:executeEmail`.

**Done when:** Manually inserting 51 fake error rows in one day produces exactly one summary email.

---

## Verification gate — Wave 2
- [ ] `bun test hub/test/error-capture-record.test.ts` (added in W6) passes the gate-ordering case.
- [ ] Curl-driven manual test: 3 envelopes within 60s same fingerprint → 1 `pending`, 2 `skipped_dedupe`.
- [ ] After 20 dispatched in an hour → 21st is `skipped_rate_limit`.

---

## Wave 3 — Session dispatch (after Wave 2)

### T8. Prompt builder
**Files:** `hub/src/error-capture/prompt.ts` (new)
- `buildDispatchPrompt({ project, error, session, runId })` → string. Renders the template from CONTEXT.md "Dispatch prompt template" with all template vars.
- Pretty-prints stacktrace JSON with 2-space indent, caps at 8KB (truncate with `…(truncated)` marker) to stay under any future per-message size cap.

### T9. Session dispatcher
**Files:** `hub/src/error-capture/dispatcher.ts` (new)
- `dispatch(errorRow, project)`:
  1. Resolve `session_id` from `project`. If `NULL` → mark `skipped_disabled`, log, return.
  2. Look up agent socket via existing `hub/src/ws/registry.ts`. If offline → push to grace buffer (T11) and mark `dispatch_status='pending'` (already is); return.
  3. Insert `error_runs` row `(status='pending', session_id, started_at=now())`.
  4. `sessionQueue.enqueue(session_id, runId)`. On `dropped` → mark error `skipped_rate_limit error='session_busy'`, run `cancelled error='session_busy'`, broadcast event, return.
  5. On `dispatched` → call `sendDispatch(socket, project, errorRow, runId)` (T10).
- `promote(sessionId, runId)`: invoked by `session-queue.setOnPromote` handler. Look up the run + error, repeat steps 4-5 with `enqueue` returning `'dispatched'` (since slot is now free).

### T10. Agent send path
**Files:** `hub/src/error-capture/sender.ts` (new), `hub/src/ws/agent-protocol.ts` (extend)
- Extend the outbound `user_message` Zod schema to accept an optional `metadata: z.record(z.unknown()).optional()` block.
- `sendDispatch(socket, project, errorRow, runId)`:
  - Build prompt via `buildDispatchPrompt`.
  - Send `{ type: 'user_message', session_id, message_id, content, metadata: { source: 'error_capture', error_id, run_id, project_id } }` via the existing agent send helper.
  - Mark `error_runs.status='running'`, `errors.dispatch_status='dispatched'`, `errors.dispatched_at=now()`, `errors.run_id=runId`.
  - Subscribe (one-shot) to the next `assistant_message` / `result` for that session. On result: write `output_snippet` (first 1KB), `cost_usd`, `duration_ms`, `finished_at=now()`, `status='succeeded'`. Also call `sessionQueue.markFinished(session_id)` (this is what the existing agent.ts `status: idle` branch already does — make sure we don't double-mark; co-ordinate via a shared "this run is mine" guard).

### T11. Offline-grace replay
**Files:** `hub/src/error-capture/grace.ts` (new), hook in `hub/src/ws/agent.ts` auth-success branch
- `Map<sessionId, Array<errorId>>` keyed by target session.
- On agent auth success: for each session bound to that agent, drain matching pending error_ids inserted within last 10 min; call `dispatcher.dispatch` for each. Older → mark `skipped_offline` and trigger daily-summary email.
- Background sweep every 60s expires stale pending errors.

### T12. WS broadcast events
**Files:** `hub/src/ws/protocol.ts` (extend), `hub/src/ws/registry.ts` (use existing `broadcastToUser`)
- Add outbound client-bound message types: `error_received { project_id, error_id, error_type, error_value, fingerprint, received_at, dispatch_status }`, `error_dispatched { project_id, error_id, run_id, session_id }`, `error_run_finished { project_id, error_id, run_id, status, snippet, cost_usd, duration_ms }`.
- Wire emissions in T5 (after insert), T9 (after enqueue), T10 (after finalize).

---

## Verification gate — Wave 3
- [ ] End-to-end smoke: hand-crafted envelope with key matching a project that has `session_id` set → run row created `running` → mock agent socket receives `user_message` with the prompt → mock result → run flips to `succeeded`.
- [ ] Offline path: send envelope while agent socket is closed → row stays `pending` → bring agent up within 10 min → run dispatches automatically.
- [ ] Session-busy path: two errors in flight → second lands `skipped_rate_limit error='session_busy'`.

---

## Wave 4 — REST + UI (after Wave 3; T13/T14/T15/T16 can run in parallel)

### T13. REST — error_projects CRUD `[P]`
**Files:** `hub/src/api/error-projects.ts` (new), wired in `hub/src/index.ts`
- `GET /api/error-projects` (list user's projects + their `sentry_key`, `dsn`, `session_id`, counters).
- `POST /api/error-projects` `{ name, session_id, dedupe_window_seconds?, rate_limit_per_hour?, daily_dispatch_cap? }` → generates `sentry_key`, returns row with derived DSN.
- `PATCH /api/error-projects/:id`, `DELETE /api/error-projects/:id`.
- All routes use existing JWT middleware + `user_id` scoping.

### T14. REST — errors + runs read `[P]`
**Files:** `hub/src/api/error-runs.ts` (new)
- `GET /api/error-projects/:project_id/errors?limit=50&before=<cursor>` — recent errors with their `dispatch_status` and `run_id`.
- `GET /api/error-projects/:project_id/runs?limit=50&before=<cursor>` — recent runs.
- `GET /api/error-runs/:id` — full run detail (snippet, error, links to session view).

### T15. Settings UI — "Error Capture" tab `[P]`
**Files:** `web/src/components/ErrorCapturePage.tsx` (new), wire into `web/src/components/SettingsPage.tsx`
- List of `error_projects` (name, linked session pill, today's error count, "show DSN" toggle reveals the DSN string + copy button).
- "Create project" modal: name + `<select>` of user's sessions + advanced fields collapsed (dedupe / rate-limit / daily-cap).
- Per-project detail panel: recent errors table (timestamp · type · value · status pill · dispatch link), recent runs table.
- Visual baseline: `web/src/components/SettingsPage.tsx` (subtle cards, indigo accent, status color pills per the global UI rules).

### T16. Live WS updates in UI `[P]`
**Files:** `web/src/hooks/useErrorCaptureFeed.ts` (new), used by `ErrorCapturePage.tsx`
- Subscribes to client WS, handles the new event types from T12, updates the page's local store.
- Toast on `error_dispatched`; row flips to "Fixing…" then "Fixed" / "Failed" on `error_run_finished`.

---

## Verification gate — Wave 4
- [ ] Create project via UI → DSN shown → copy/paste works.
- [ ] Real Sentry SDK in a test Node app pointed at the DSN → error fires → appears in UI within 1s.
- [ ] Linked session shows the prompt arrive in the chat view (the existing session UI surfaces it naturally — no UI changes needed there).

---

## Wave 5 — SDK auto-install + Coolify env push (after Wave 4; T17/T18/T19 parallel after T20 lands)

### T20. Stack detect + snippet builder
**Files:** `hub/src/error-capture/setup/detect.ts` (new), `hub/src/error-capture/setup/snippet.ts` (new)
- Lift `detect.ts` from `claude-code-self-heal/src/setup/detect.ts`, strip to the 4 supported stacks per CONTEXT.md "Supported SDK stacks".
- Lift `snippet.ts` from self-heal; keep idempotency check (`source.includes('@sentry/node')` / `sentry_sdk`).
- Add Next.js branch that produces 3 file edits (`sentry.server.config.ts`, `sentry.client.config.ts`, `next.config.{js,ts}` wrap).
- Output of `planSetup(repoFiles)`: discriminated union `{ ok: true, stack, edits: FileEdit[], manifestUpdate: ManifestPatch } | { ok: false, reason: 'unsupported', tried: string[] }`.

### T17. DSN generator `[P]`
**Files:** `hub/src/error-capture/dsn.ts` (new)
- `buildDsn(project)`: `https://${project.sentry_key}@${PUBLIC_HOST}/${project.id}` where `PUBLIC_HOST` is from `REMO_PUBLIC_URL` env (strip protocol).
- Exposed on `GET /api/error-projects/:id` and `GET /api/error-projects` responses.

### T18. Supervisor git-ops command for SDK install `[P]`
**Files:** `hub/src/error-capture/setup/orchestrator.ts` (new), `hub/src/ws/supervisor-protocol.ts` (extend if needed)
- `runSdkInstall(projectId, userId)`:
  1. Find supervisor + repo path linked to the session (existing supervisor-registry lookup).
  2. Ask supervisor to read the manifest + likely entry files (use existing supervisor file-read commands; if not present, this depends on `04-coolify-dev-supervisor` work — confirm before W5).
  3. Run `planSetup(files)`. If `ok: false` → email user the copy-paste snippet + DSN (via `executeEmail`), record status `unsupported`, stop.
  4. Run `run_command` against the supervisor: a single shell script that applies the edits + manifest patch + `git add -A && git commit -m "chore: add sentry sdk for remo error capture" && git push origin <default-branch>`. Idempotent: re-running on an already-instrumented repo is a no-op (snippet check catches it).
  5. Record outcome on `error_projects` (`setup_status`, `setup_last_attempt_at`, `setup_error`).

### T19. Coolify env-var PATCH `[P]`
**Files:** `hub/src/error-capture/coolify.ts` (new)
- `setSentryDsnEnv(coolifyAppUuid, dsn)`: PATCH `https://coolify.titaniumlabs.us/api/v1/applications/{uuid}/envs` with `{ key: 'SENTRY_DSN', value: dsn, ... }` per RESEARCH.md "Coolify env-var PATCH".
- Look up `coolifyAppUuid` from `error_projects.coolify_app_uuid` (add column in T1 — confirm; if not, add it here as a migration patch). Default: NULL, in which case skip with a warning + email "please add SENTRY_DSN=<dsn> to your Coolify env vars manually".
- 5s timeout, no retry — user can re-click "Setup" if it fails.

### T21. Setup UI modal
**Files:** `web/src/components/ErrorCaptureSetupModal.tsx` (new), opened from `ErrorCapturePage.tsx`
- Single button "Auto-install SDK" → calls `POST /api/error-projects/:id/setup` → progress steps (detect → edit → commit → push → coolify env) live-updated via WS.
- On `unsupported`: show the copy-paste snippet + DSN in a code block with a "copy" button.

### T22. REST — setup endpoint
**Files:** `hub/src/api/error-projects.ts` (extend T13)
- `POST /api/error-projects/:id/setup` → calls `orchestrator.runSdkInstall` in the background, immediately returns `{ accepted: true }`. Progress arrives via WS.

---

## Verification gate — Wave 5
- [ ] Run `setup` against a test Express repo with a real supervisor → entry file gains the snippet, `package.json` gains the dep, commit lands on default branch, Coolify env shows `SENTRY_DSN`.
- [ ] Re-run `setup` → no-op (idempotent), no second commit.
- [ ] Run against a Rails repo (unsupported) → email arrives with copy-paste snippet.

---

## Wave 6 — Tests + ship + decommission

### T23. Unit tests
**Files:** `hub/test/error-capture.test.ts` (new)
- Envelope parser: gzip + plain, malformed → throws.
- Fingerprint normalize: stable for varying timestamps/paths/UUIDs.
- Gate ordering: disabled > dedupe > rate-limit > daily-cap.
- Prompt template: all template vars substituted, stacktrace truncation works.
- Session-queue interaction: dispatched / queued / dropped paths produce the right `dispatch_status`.

### T24. E2E smoke (DB-backed, skipped without `REMO_E2E_DB_URL`)
**Files:** `hub/test/error-capture.e2e.test.ts` (new)
- Mirror `hub/test/scheduled-tasks.e2e.test.ts` layout: spin up a fake agent socket, create a project, POST a real Sentry envelope to the intake route, assert the run materializes and reaches `succeeded` after a mock `assistant_message` is fed in.

### T25. Docs
**Files:** `README.md`, `CLAUDE.md`, `docs/error-capture.md` (new)
- New top-level doc covering: how it works, DSN format, setting up a project, supported stacks, dispatch prompt shape, troubleshooting (offline grace, dedupe, daily cap).
- README: one-line mention + link to the new doc.
- `CLAUDE.md`: extend the "Scheduled Tasks" section's neighbor with an "Error Capture" section pointing at the new doc and listing the env vars (`REMO_PUBLIC_URL`, `COOLIFY_TOKEN`, emails4agents triplet — all already documented).

### T26. Deploy + verify in prod
- Push branch → merge → Coolify auto-deploys remo-code.
- Create one real `error_project` linked to a known session.
- Run SDK setup against a sacrificial Coolify app.
- Throw a hand-crafted error in that app → confirm end-to-end round trip lands in the linked Claude session.

### T27. Decommission self-heal
**Files:** none (operational checklist from RESEARCH.md "Decommission of self-heal")
- Execute the checklist in order. Each step gets a tiny PR/issue update or a deletion commit (where appropriate).

---

## Verification gates
Re-listed for clarity:
- After W2: gate-ordering + manual dedupe/rate-limit/cap.
- After W3: e2e smoke + offline-grace + session-busy.
- After W4: live UI updates from real Sentry SDK.
- After W5: idempotent SDK install + unsupported-stack email.
- After W6: prod verification + self-heal infra killed.

---

## Out of scope reminders
- No `target_kind=supervisor`. No `all_sessions` fan-out.
- No auto-link of project ↔ session by repo URL — operator picks.
- No PR-opening. Claude commits directly in-session.
- No sourcemap upload pipeline.
- No tracing / performance / replay ingestion.
- No retry of failed dispatches (Claude can request retry via the session itself if needed).
- No webhook post-run action in v1 (HMAC helper landed for future use only).

---

## Risk mitigations baked in
- **Dispatch flood** → 3-layer gating (dedupe / per-hour / daily-cap), all per-project, all configurable.
- **Session-busy** → reuse battle-tested `session-queue.ts`; drops are loud but bounded.
- **Agent offline at error time** → 10-min grace replay; older → silent skip + daily summary email.
- **Notification spam** → `notifications_sent` table gates "you hit the cap" emails to once-per-day-per-project.
- **Idempotent SDK install** → snippet-presence check; re-running setup is a no-op.
- **Unsupported stack** → email the user the snippet instead of failing silently.
- **DB cascade safety** → `error_projects.session_id ON DELETE SET NULL` (deleting a session disables but doesn't break); `errors ON DELETE CASCADE` of project removes orphans.
- **Public intake endpoint** → `sentry_key` is the credential; unknown keys 401 silently to avoid project enumeration.
- **Self-heal cutover** → don't decommission self-heal infra until prod round-trip is verified.
