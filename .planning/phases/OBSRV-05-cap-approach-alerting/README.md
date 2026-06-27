# Phase 5: Cap-Approach Alerting (OBSRV-05)

Requirements: METRIC-03. See `.planning/ROADMAP.md`.
Stage-gated, throttled `notify.ts` fan-out when daily token OR cost crosses a configurable % of either cap.
Reuses existing notify plumbing. Observe-only — no cap-behavior change in gates.ts.
Depends on Phase 3 (reads the daily token/cost-vs-ceiling metrics).
