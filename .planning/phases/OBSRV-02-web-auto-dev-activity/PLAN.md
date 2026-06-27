# OBSRV-02: Web Auto-Dev Activity Panel

**Goals:** RUNLOG-03 (per-session activity panel) + RUNLOG-04 (hub-wide run feed)

## Deliverables

| File | Purpose |
|------|---------|
| `web/src/lib/run-log-api.ts` | Typed API client for `GET /api/orchestrator/run-log` |
| `web/src/components/AutoDevActivityPanel.tsx` | Dual-mode panel (per-session + hub-wide) |
| `web/src/components/SupervisorPage.tsx` | Orchestrator row → expandable per-session timeline |
| `web/src/pages/settings/ConnectionsTab.tsx` | Collapsible hub-wide feed below the repo table |
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

The activity surface lives entirely inside the **Connections** view — NOT a Settings
tab — to preserve the documented four-tab invariant (Connections / Credentials / Usage /
Profile). Per-session timeline expands from the pinned orchestrator row; the hub-wide
feed is a collapsible section beneath the repo table.
