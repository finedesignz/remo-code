# Phase 31 — web-orchestrator-editor · SUMMARY

**Status:** Complete (PASS) · commits `bc97d97` (hub), `d61deda` (web) on `feat/auto-dev-orchestrator`

The orchestrator configuration UI + its hub API. Configures data only — no live behavior (flag-OFF).

## Delivered
- **Hub:** `hub/src/api/orchestrator-tasks.ts` (Zod router, mounted before the `/api/*` catch-all) — GET/POST task per session (409 one-per-session), PATCH stage, apply-preset, row CRUD + reorder; `command-set.ts`; DAL task/row helpers; OpenAPI + `docs:sync`.
- **Web:** `useOrchestrator` hook, `FrequencyControl` (reuses `ScheduleRuleRow`, adds Never/Once), `OrchestratorTab` (stage selector + apply-preset, drafted-prompt panel, row table with add-command/add-micro-prompt + reorder), `TasksPage` view switch. Blue accent only.

## Verification
14 route/guard + 26 new-file tests pass; `build:web` clean; baseline 1470/0; no-indigo passes; canonical main clean.
