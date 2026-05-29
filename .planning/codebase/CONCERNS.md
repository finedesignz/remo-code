# Codebase Concerns

**Analysis Date:** 2026-05-28
**Branch:** main (post-Phase 12 UI restructure)

> **Note (Phase 09, 2026-05-26):** The agent/ workspace and channel/ plugin are retired. The local CLI runner now lives in supervisor/src/ and ships exclusively as a Tauri MSI desktop app. The hub /ws/agent route is unchanged. References to agent/, npx remo-code-agent, claude-remote, or /ws/channel are historical.

---

## CRITICAL (production risk, security, or data integrity)

### Auth cutover incomplete — TITANIUM_BYPASS=true in prod

- **Issue:** Phase 07 (Titanium Licensing magic-link + opaque cookie sessions) is half-shipped. `TITANIUM_BYPASS=true` is set in Coolify env, which short-circuits the JWKS warm-up, license gate, and magic-link flow. All users currently authenticate via legacy bcrypt + JWT path (`ALLOW_LEGACY_LOGIN=true` semantics).
- **Files:** `hub/src/config.ts`, `hub/src/license-gate.ts`, `hub/src/api/auth.ts`, `hub/scripts/migrate-users-to-titanium.ts`.
- **Impact:** Phase 07.5 cleanup (delete `password_hash`, `bcrypt`, `JWT_SECRET`, `hub/src/auth/password.ts`) is blocked. Users have no `titanium_subject` populated — the migration script has not been run against prod.
- **Fix approach:** (1) Dry-run migration script, (2) backfill `titanium_subject` for matched users, (3) flip `TITANIUM_BYPASS=false`, (4) soak 7d, (5) run Phase 07.5 deletion phase.

### `LICENSE_REQUIRED=false` in prod (permissive mode)

- **Issue:** License-gate middleware is in permissive mode — `license_status != 'active'` does NOT 402.
- **Files:** `hub/src/license-gate.ts`, `hub/src/config.ts`.
- **Impact:** No revenue gating active. Acceptable during Phase 07 soak; becomes a billing leak the moment Titanium auth flips on without flipping this.
- **Fix approach:** Flip to `true` in same release as `TITANIUM_BYPASS=false`. Add launch checklist gate.

### `idx_sessions_user_project_unique` migration blocked by duplicate rows

- **Issue:** Phase 08 (session-keying) added `CREATE UNIQUE INDEX idx_sessions_user_project_unique ON sessions(user_id, project_dir)`. Migration fails on prod because duplicate `(user_id, project_dir)` rows exist.
- **Files:** `hub/src/db/schema.sql`, `hub/test/session-keying-dal.test.ts`.
- **Impact:** Constraint never enforced in prod → duplicate sessions can be created → supervisor `findOrCreateSessionByProjectDir` race on reconnect can hand back the wrong session.
- **Fix approach:** One-shot data-cleanup script: pick newest row per `(user_id, project_dir)`, reassign `messages.session_id` to winner via FK, delete losers, THEN apply unique index. Single transaction.

### 2 leaked legacy `remokey_*` API keys (rotation flow needs UI fix)

- **Issue:** Two leaked legacy `remokey_*` keys identified — one revoked 2026-05-19, one never had a corresponding DB row (already inert).
- **Files:** `hub/src/api/api-keys.ts`, `web/src/components/SettingsPage.tsx`.
- **Impact:** Current rotation UX is "revoke + create new + paste into supervisor wizard." No atomic rotate verb.
- **Fix approach:** Add `POST /api/keys/:id/rotate` endpoint that revokes + creates in one transaction, returns new plaintext exactly once. Surface as "Rotate" button in API Keys list.

---

## HIGH (active investigation, deferred work, regression risk)

### Pre-existing baseline test failures (7 in hub)

- **Issue:** 7 hub tests fail on `main` and have failed since before Phase 12.
  - `insertRunV2 started_at` — 5 failures (column nullability / default mismatch).
  - `supervisor-registry reconnect race` — 2 failures (timing-dependent).
- **Files:** `hub/test/scheduled-tasks.e2e.test.ts`, `hub/test/supervisor-registry.test.ts`.
- **Impact:** CI noisy; new regressions in these areas masked. Phase verifier gates "PASS if baseline failures unchanged" — fragile.
- **Fix approach:** Tech-debt phase: fix `started_at` default in `schema.sql` or test fixture; rewrite supervisor-registry reconnect tests with injected clock instead of real `setTimeout`.

### Phase 12 deferred review items (ME-02..ME-09, LO-01..03, IN-03)

- **Issue:** `.planning/phases/12-ui-restructure/REVIEW.md` enumerates medium/low/info items explicitly deferred to ship.
- **Files:** `.planning/phases/12-ui-restructure/REVIEW.md`.
- **Impact:** UI polish + deep-link edge cases + a11y items will rot if not lifted into a follow-up plan within 1–2 weeks.
- **Fix approach:** Triage subagent converts each ME-/LO-/IN- line into a sized follow-up under `.planning/phases/13-phase12-cleanup/`.

### Mobile Settings load issue (PR #117)

- **Issue:** Mobile Settings page reportedly failed to load on some devices. PR #117 deployed an error boundary as diagnostic + partial mitigation. Awaiting user feedback.
- **Files:** `web/src/components/SettingsPage.tsx`, `web/src/components/AppChrome.tsx`, PR #117 boundary.
- **Impact:** Mobile users may see blank Settings. Root cause unconfirmed (suspected: dynamic import / Vite chunk-load failure, or hook throwing pre-paint on small screens).
- **Fix approach:** Wire boundary telemetry to error-capture intake (`/api/sentry/...`) to get fingerprinted stack traces. Root-cause from data, not speculation.

### Telegram chat bridge (#114) × Phase 12 untested in prod

- **Issue:** Telegram bridge merged immediately before Phase 12 UI restructure. Not yet soaked together.
- **Files:** Telegram bridge files, `web/src/components/AppChrome.tsx`.
- **Impact:** Telegram deep-links may target old routes; Phase 12 redirect map handles `/schedules/runs/:id` but Telegram-specific surfaces unverified.
- **Fix approach:** E2E smoke — fire a Telegram post-run action, click from phone, verify landing. Add to release checklist.

### Supervisor sidecar WS 1006 disconnect every ~5min

- **Issue:** Supervisor's hub WS closes with code 1006 roughly every 5 minutes — idle timeout firing.
- **Files:** `hub/src/ws/agent.ts`, `supervisor/src/index.ts`.
- **Impact:** Cosmetic-but-noisy. Auto-reconnects within ~1s; activity events in the gap may queue or drop.
- **Fix approach:** Separate ticket open. Align heartbeat: supervisor ping every 25s, hub idle 60s. Verify fronting layer (Coolify/Caddy) idle cutoff.

### Phase 09 supervisor MSI version requirement

- **Issue:** Phase 09 `legacy_agent_spawn_disabled` fix + PR #96 (in-process claude-runner) require supervisor MSI ≥ v0.5.3.
- **Files:** `supervisor/src/index.ts`, `supervisor/tauri/src-tauri/Cargo.toml`, `supervisor/tauri/ui/package.json`.
- **Impact:** Users on ≤v0.5.2 get `legacy_agent_spawn_disabled` errors on session start. Tauri auto-updater handles most; auto-update-disabled users stuck.
- **Fix approach:** Hub-side check on `auth` payload — compare `supervisor_version` against hardcoded minimum; send `version_too_old` event the supervisor renders as tray notification with latest-release URL.

---

## MEDIUM (operational hygiene, observability)

### `/healthz` does not exist — only `/health`

- **Issue:** Hub exposes `/health` but not `/healthz`. Many monitors default to `/healthz`.
- **Files:** `hub/src/index.ts`.
- **Impact:** Silent monitoring gap if any external tool is configured for `/healthz`. Coolify uses `/health` and works.
- **Fix approach:** One-line alias to same handler. Zero risk.

### AUDIT-2026-05-25.md exists but not linked

- **Issue:** A security/code audit document dated 2026-05-25 is referenced in handoff notes but no canonical location established.
- **Files:** Unknown — likely under `.planning/` or `docs/`.
- **Impact:** Audit findings may not be tracked against follow-up phases.
- **Fix approach:** Locate (grep), move to `.planning/audits/`, triage findings.

### HKCU Run-key auto-start (not NSSM) for supervisor

- **Issue:** Supervisor auto-start uses `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` rather than NSSM/Windows Service.
- **Files:** `supervisor/tauri/src-tauri/src/main.rs` (Tauri `autostart` plugin).
- **Impact:** Supervisor only runs when user is logged in. Headless deployments won't auto-start. Acceptable for desktop use; document the limit.
- **Fix approach:** Document in `docs/` + first-run wizard. Opt-in NSSM installer if headless becomes a requirement.

### `{{run_url}}` template depends on Phase 12 deep-link redirect map

- **Issue:** Post-run actions emit `{{run_url}}` = `${REMO_PUBLIC_URL}/schedules/runs/:id`. Phase 12 moved Schedules under Settings with a redirect from `/schedules/*`.
- **Files:** `hub/src/scheduler/post-run/template.ts`, `web/src/App.tsx`, `web/src/components/AppChrome.tsx`.
- **Impact:** If a future UI phase strips the redirect, every historical email/Telegram/webhook link breaks.
- **Fix approach:** Pin redirect with route-table test. Comment at the redirect declaration. Consider emitting fully-resolved current URL at render time rather than historical path.

---

## LOW (dead code candidates, polish)

### `PendingLocalRepoPrompt` / `LaunchButton` / `CloneHereModal` — wiring unclear

- **Issue:** Three components referenced by Sidebar; full integration path unclear — may be feature-flagged off or behind code paths never hit.
- **Files:** `web/src/components/PendingLocalRepoPrompt.tsx`, `web/src/components/LaunchButton.tsx`, `web/src/components/CloneHereModal.tsx`, `web/src/hooks/usePendingLocalRepos.ts`, `web/src/hooks/useRepoCreateJob.ts`.
- **Impact:** Dead-code risk; bundle weight + test surface for behavior that may never trigger.
- **Fix approach:** Add `console.debug` at mount, exercise typical flows, observe. If never fires, gate behind feature flag or delete. If conditional, document the trigger.

### Revanote subsystem is large and recent — coverage thin

- **Issue:** Substantial Revanote feature (10+ new files under `hub/src/revanote/`, `hub/src/api/revanote-*`, `web/src/components/RevanotePage.tsx`) landed recently. Test files exist; real-world soak minimal.
- **Files:** `hub/src/revanote/*`, `hub/src/api/revanote-{annotations,mappings,webhook}.ts`, `hub/src/db/revanote-dal.ts`, `web/src/components/RevanotePage.tsx`.
- **Impact:** Bugs likely as users adopt. No dedicated CLAUDE.md section yet — onboarding weak for future Claude sessions.
- **Fix approach:** Add Revanote section to `CLAUDE.md` once architecture stabilizes. Wire Revanote errors into error-capture to auto-route to bound session.

### Documentation drift risk on phase-specific CLAUDE.md sections

- **Issue:** CLAUDE.md root has Phase 05/06/07 sections. Phases 08/09/12 NOT enshrined.
- **Files:** `CLAUDE.md`, `docs/auth.md`, `docs/scheduled-tasks.md`, `docs/error-capture.md`, `docs/codex-and-rootless.md`.
- **Impact:** New Claude sessions miss recent invariants. "Update docs in same commit" discipline is per-section, unenforced for new phases.
- **Fix approach:** Append Phase 08/09/12 sections following the template. Add `docs-drift` CI rule flagging PRs that touch `hub/src/scheduler/**` or `hub/src/revanote/**` without matching doc updates (mirror existing OpenAPI drift gate).

---

## Test Coverage Gaps

- **Coolify webhook ingress** — `hub/src/api/coolify-webhook.ts` has unit tests for HMAC + URL-token paths but no integration test for full failure-deployment → triage → github-issue chain end-to-end.
- **Supervisor reconnect under load** — Existing tests are unit-level mocks; no chaos-style "kill WS 100 times in 5 min" test.
- **Magic-link replay protection** — `TITANIUM_REQUIRE_REDIS=true` invariant documented but no test verifies boot-fail when Redis absent.
- **License-gate exclusion list** — Excluded paths (`/api/profile/license`, `/healthz`, webhooks, `/ws/agent`) documented but no test asserts they STAY excluded after future middleware edits.

---

*Concerns audit: 2026-05-28*
