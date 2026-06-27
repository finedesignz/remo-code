# OBSRV-02: Web Auto-Dev Activity Panel

**Goals:** RUNLOG-03 (per-session activity panel) + RUNLOG-04 (hub-wide run feed)

## Deliverables

| File | Purpose |
|------|---------|
| `web/src/lib/run-log-api.ts` | Typed API client for `GET /api/orchestrator/run-log` |
| `web/src/components/AutoDevActivityPanel.tsx` | Dual-mode panel (per-session + hub-wide) |
| `web/src/pages/settings/ActivityTab.tsx` | Hub-wide feed mounted in Settings > Activity |
| `web/src/pages/SettingsPage.tsx` | Added "activity" tab |
| `web/test/auto-dev-activity.test.tsx` | 6 unit tests |

## Constraints

- Web-only. Zero hub dispatch/gate/orchestrator changes.
- Accent = blue (`text-blue-400`, `bg-blue-600/15`). No indigo.
- `fail_max: 0` in `tools/regression-baseline.json` — fix tests, don't relax.
- Smallest diff; match existing SPA patterns.

## API contract consumed

```
GET /api/orchestrator/run-log?limit=N&offset=M[&session_id=X]
→ { items: RoutineRunLogEntry[], limit: number, offset: number }
```

## Design

`AutoDevActivityPanel` is dual-mode: when `sessionId` is provided → per-session view;
when absent → hub-wide feed with a repo label badge per row. Expandable rows surface
rationale / gap / reviewer verdict / deploy-verify detail via a blue left-border block.

`ActivityTab` wraps the panel in hub-wide mode and is mounted as a 5th Settings tab
alongside Connections / Credentials / Usage / Profile.
