---
status: investigating
trigger: "UI shows 6 sessions counter but only 2 in sidebar list; user cannot start another session"
created: 2026-05-24T00:00:00Z
updated: 2026-05-24T00:00:00Z
---

## Current Focus

hypothesis: counter and list draw from different sources (e.g., counter = DB total or stale REST, list = filtered/live-agent-only WS event)
test: read sidebar + hub session_list code + REST sessions handler + agent connection lifecycle
expecting: locate the divergence between the count source and the list source
next_action: read web/src/components/Sidebar.tsx, hub/src/api/sessions or routes, hub/src/ws producer for session_list, hub/src/db/schema.sql

## Symptoms

expected: counter matches list length; new-session button works
actual: counter shows 6, list shows 2; new-session click does nothing
errors: unknown until logs pulled
reproduction: open https://app.remo-code.com — observe sidebar; click "new session"
started: unknown

## Eliminated

## Evidence

## Resolution

root_cause:
fix:
files_changed: []
