# Phase 4: Autospawn Shadow Dry-Run (OBSRV-04)

Requirements: SHADOW-01..04. See `.planning/ROADMAP.md`.
`REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW=1`: `maybeAutospawnOffline` runs full gate/allowlist/cap AND-chain,
records "would-have-spawned" record — NEVER calls `launchSessionForUser`, NEVER dispatches. Guard test.
OFF by default, true no-op when off/allowlist empty. Never flip AUTOSPAWN, never populate allowlist.
Depends on Phase 1 (records surface via the same run-log API/UI).
