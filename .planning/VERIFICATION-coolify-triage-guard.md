---
branch: fix/coolify-triage-guard
verified: 2026-05-30
verifier: gsd-verifier (independent QC, no code edits)
status: passed
verdict: SHIP
score: 3/3 goals PASS
---

# QC — fix/coolify-triage-guard

## 1. Master switch — PASS

- Schema idempotent, no backfill: `hub/src/db/schema.sql:601`
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS coolify_auto_triage_enabled BOOLEAN NOT NULL DEFAULT true;`
- DAL: `getUserCoolifyAutoTriageEnabled` `hub/src/db/dal.ts:1126` (NULL→true `:1130`); `setUserCoolifyAutoTriageEnabled` `:1134` (UPDATE + updated_at `:1139`).
- PATCH `/api/account/coolify-auto-triage {enabled}`: `hub/src/api/account.ts:291`; boolean-validates `:299`; returns `{auto_triage_enabled}` `:304`.
  CSRF: global `csrfGuard` on mutating `/api/*` (double-submit cookie), documented `account.ts:290`.
- GET surfaces `auto_triage_enabled`: `account.ts:56` loads real value, returned `:63`.
- Web Toggle + InfoTip wired, instant save: `web/src/pages/settings/CredentialsTab.tsx:184` `CoolifyAutoTriageToggle`; GET hydrate `:193-198`; PATCH on change `:217-222`; `<Toggle>` `:240` (ui blue Toggle); `<InfoTip>` `:238`.

## 2. deployment.failed gating — PASS

`hub/src/api/coolify-webhook.ts` `handleVerifiedWebhook` (`:239` failed-only branch):
- Switch OFF → skip dispatch, reason `auto_triage_disabled`, still persists metadata + 202: `:240-245`, status row persisted at `:226`, response 202 below.
- Active dev session → skip, reason `suppressed_active_dev_session`: `:259-263` via `hasActiveSessionForRepo(userId, git_repository)` `:253`.
- Else dispatch: `:265 void dispatchTriage(...)`.
- Builds ON #220 storm-dedupe (no bypass/dup): guard sits BEFORE `dispatchTriage`, which still calls `claimDeployFailure` internally `:111` (fingerprint claim preserved).
- Repo identity reuse: `hasActiveSessionForRepo` → `repoKeyFromGitRepository` (`sessions/repo-routing.ts:45`, importing `lib/repo-key.ts:26`); "active" = live `/ws/agent` channel (`getChannel`, same def as GET /api/sessions active flag) `repo-routing.ts:8-13,67-72`.
- Fail-open on lookup error: `hasActiveSessionForRepo` throws on DB error (`repo-routing.ts:78-80`); webhook try/catch `:252-258` dispatches anyway (logs, never silent-drops).

## 3. Tests — PASS

`cd hub && bun test test/coolify-webhook.test.ts` → 24 pass / 0 fail / 67 expects.
4 new cases (`test/coolify-webhook.test.ts:305-371`):
- OFF → no dispatch + `auto_triage_disabled` `:326`
- active → suppressed + `suppressed_active_dev_session` `:343`
- ON + no session → dispatched `:306`
- succeeded → no triage `:359`

## Gates

- `bun run build:web` → clean (tsc -b + vite, 390 modules, built 2.05s).
- `grep -rn indigo web/src` → 0 matches.

## Verdict: SHIP
All 3 goals + both gates met. No blockers. (Grep display mangles `/` ↔ `\` on this host; raw Read confirms all comments are valid `//` `/**` — no syntax issue.)
