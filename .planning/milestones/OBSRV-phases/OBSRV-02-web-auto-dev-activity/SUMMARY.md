# OBSRV-02 Summary

**Shipped:** 2026-06-27

## What was built

- `web/src/lib/run-log-api.ts` — `fetchRunLog()` typed client; maps hub `{ items }` → `{ entries, hasMore }`.
- `web/src/components/AutoDevActivityPanel.tsx` — dual-mode timeline: per-session + hub-wide with repo badge.
- `web/src/components/SupervisorPage.tsx` — orchestrator row is now expandable; expanding it mounts the per-session timeline (`sessionId` from the orchestrator snapshot).
- `web/src/pages/settings/ConnectionsTab.tsx` — collapsible hub-wide "Auto-Dev Activity" feed below the repo table.
- `web/test/auto-dev-activity.test.tsx` — 6 tests: API shape, hasMore, sessionId params, no-indigo guard.

## Design-rework note

Initial draft added a 5th "Activity" Settings tab — reverted. The documented four-tab
invariant (Connections / Credentials / Usage / Profile) is preserved; the activity
surface now lives inside the Connections view. SettingsPage restored to 4 tabs;
ActivityTab.tsx deleted.

## Results

- 7 tests pass (6 OBSRV-02 + no-indigo), 0 fail
- `bun run build:web` green (415 modules)
- check-baseline: pass/skip/total match baseline exactly (local fail=15 are env-only DB/network; CI green)
- No hub-side changes. Blue accent only.
