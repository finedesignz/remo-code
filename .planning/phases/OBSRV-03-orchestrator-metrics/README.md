# Phase 3: Orchestrator Metrics Counters (OBSRV-03)

Requirements: METRIC-01, METRIC-02. See `.planning/ROADMAP.md`.
Additive counters in `hub/src/observability/metrics.ts`: cycles enqueued/drained/skipped, skip-reason
histogram (incl `no_session`/`offline`), dispatch outcomes, daily token+cost vs 50M/$ ceilings (read-only).
No deps — startable now. No cap-behavior change in gates.ts.
