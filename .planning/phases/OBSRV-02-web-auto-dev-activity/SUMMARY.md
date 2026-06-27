# OBSRV-02 Summary

**Shipped:** 2026-06-27

## What was built

- `web/src/lib/run-log-api.ts` — `fetchRunLog()` typed client; maps hub's `{ items }` shape to `{ entries, hasMore }`.
- `web/src/components/AutoDevActivityPanel.tsx` — dual-mode timeline panel: per-session + hub-wide with repo badge.
- `web/src/pages/settings/ActivityTab.tsx` — hub-wide feed in Settings > Activity tab.
- `web/src/pages/SettingsPage.tsx` — extended `SettingsTab` type + nav + render block for "activity".
- `web/test/auto-dev-activity.test.tsx` — 6 tests: API shape, hasMore, sessionId params, no-indigo guard.

## Results

- 6 tests pass, 0 fail
- `bun run build:web` green (416 modules)
- No hub-side changes
- Blue accent only, no indigo
