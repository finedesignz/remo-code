---
status: investigating
trigger: "Web UI shows TitaniumTower supervisor as offline (hasn't checked in since 8:50:04 AM) but supervisor IS connected and responding"
created: 2026-05-25T00:00:00Z
updated: 2026-05-25T00:00:00Z
---

## Current Focus

hypothesis: `last_seen_at` only updated at WS connect, not on subsequent messages/heartbeats. UI computes online from `last_seen_at` with a recency window, so it goes stale even while WS is live.
test: Grep `last_seen_at` writes in hub/ and online-status computation in web/
expecting: writes only in WS auth/connect handler; UI threshold < age since 8:50
next_action: Search code

## Symptoms

expected: TitaniumTower shown online (WS open, responding to messages)
actual: Shown offline since 8:50:04 AM
errors: none
reproduction: Connect supervisor, wait > threshold, view supervisors list
started: After PR #25 (Phase 04) which added 90s recency check

## Eliminated

## Evidence

## Resolution

root_cause:
fix:
files_changed: []
