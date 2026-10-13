# Phase 8 - Architecture Forks

Only genuine forks (hard to reverse, trust-boundary or data-model shaping). Cheap choices are `auto-default` items in `08-CONTEXT.md`. Recommendations are adopted in CONTEXT as D-01 / D-02 pending panel confirmation.

## FORK-1: Is the QC engine deterministic hub code, or an LLM session turn?

**Question.** SPEC TQC-07 describes a "diagnostic macro prompt" with a 500K-token ceiling (`REMO_TASK_QC_TOKEN_CAP`) - an LLM turn that reads config and emits findings JSON. TQC-02/03 simultaneously define the detectors and the writer as pure, allowlisted code. Which part is the model?

**Option A - Deterministic hub-side sender (no model).** `task_qc` routes to `senders/task-qc.ts`; detectors, fix writer, digest are TypeScript. Zero tokens.
- Consequences: SC3 "never opens a dev loop" becomes structurally true (the module cannot reach `dispatch()`, `injectOrchestratorPrompt`, `task-macros`); the trust boundary shrinks to code we test (no model-authored fix kind or SQL can exist); no PTY/stream-json dependency, so Phase 3/5 plumbing is irrelevant; runs on the hub with no supervisor online. The 500K token ceiling and its tests have nothing to bound and are dropped (Phase 9's inherited-knob row must follow). OPTIMIZE is limited to the heuristic proposals in D-13 (no prose judgement). Reversible only at cost: adding a model later means a new sender, a ceiling knob, gate lists, counter-key plumbing through `dispatch()`.

**Option B - LLM session turn emits findings JSON; code applies allowlisted fixes (SPEC-literal).** A scheduled agent turn (stream-json, cost-gated) is prompted to audit and return structured findings; the hub validates against the allowlist and applies.
- Consequences: needs a bound session online (QC silently skips when the session is offline - the very failure class it detects), a PTY/stream-json runner, `dailyTokenCapGate` + a QC ceiling + `sessionInjectRateGate` in a `gates: [` list (token-cap-coverage scan), a counter key through `dispatch()`; the model's output becomes an input that picks which row to fix (prompt-injection surface: task prompts/payloads are data the model reads); non-deterministic detectors cannot meet TQC-02's "unit test with a fixture that fires and one that does not". It re-creates the "recurring unattended AI turn" shape the milestone exists to make survivable.

**Option C - Hybrid: code detects and fixes, one bounded model turn writes only the digest narrative / OPTIMIZE commentary.**
- Consequences: all of B's gating and offline-session issues for a cosmetic gain; the model sees finding evidence (task names, error strings = untrusted-ish text) and must be fenced (`fenceUntrusted`). Defer: can be layered on A later without redoing A.

**Recommendation: A.** Evidence: (1) SPEC itself makes the six detectors "pure functions over rows" with a spy test for zero writes and the writer "accept only SAFE_FIXES" - the model adds no capability the SPEC specifies; (2) the incident (08-SPEC section 1) was an unattended model turn re-injecting; an engine with no model cannot burn tokens, so the 500K ceiling is replaced by an impossibility proof (module-graph guard + zero `token_usage` rows) that is strictly stronger than a cap; (3) Phase 9 only needs "a Phase-8 pass scoped to a cause" (09-SPEC CQ-05 examples are `recompute_next_run_at` and `backfill_payload_from_sibling`, both pure-code fixes), and CQ-04's budget is a run-count ceiling, not tokens; (4) `scheduled_task_runs.cost_usd` is NULL 100%, so any model-cost accounting for QC would be unmeasurable anyway. Risk accepted: no natural-language optimization judgement in v1 (listed in Deferred).

## FORK-2: Where does the recurring audit live - a `scheduled_tasks` row or a standalone hub timer?

**Question.** TQC-01 says "a new `task_type='task_qc'` scheduled task". Alternative is a boot-started module timer (like the ghost reaper / stale-run reaper) with no task row.

**Option A - `scheduled_tasks` row, `task_type='task_qc'`, one per user (partial unique index), fired by the existing cron registry via `fireTask`.**
- Consequences: inherits cron cadence + timezone, run history rows, the Phase-4 kill-switch pre-gate for free (dispatcher.ts 236-248 sits before any task_type branch), run-history UI visibility, catchup/skip policy. Costs: enum value added in four places (schema CHECK list in place, DAL union, zod, auto-name), the UI/API can see and edit the row (needs create/edit guards - D-25), `email_summary=false` plus an engine-failure email (D-20) to avoid double/no mail, and the row can be disabled by the owner (acceptable and honoured). Risk: the audit set must exclude its own row and `__internal_*` anchors (D-03).

**Option B - Standalone module timer, no task row; runs recorded only in `task_qc_findings`.**
- Consequences: no enum change, no UI exposure, no zod/DAL churn. But it hand-rolls a second scheduler (the repo's rule: do not hand-roll per-subsystem dispatch/queue), a `setInterval` poller (global rule 23 prefers event-driven; the cron registry is the repo's event source), no run history, no kill-switch pre-gate (must be re-implemented), no owner-visible enable/disable, restart-time double-fire risk without `last_fire_at` state.

**Option C - Reuse an existing orchestrator `__internal_*` anchor row.**
- Rejected up front: anchors are `enabled=false` BY DESIGN and exempt from every audit; overloading one would make the auditor's own row invisible to itself and to the owner.

**Recommendation: A.** Evidence: the SPEC wording, the existing precedent for adding task types (Phase 11 `qc*`, TEAB, `work`: each extended the same CHECK list), the dispatcher's kill-switch pre-gate placement, and the registry already providing the only sanctioned timer. The enum-in-four-places cost is mechanical and test-pinned; a `task-type-enum-sync` assertion is cheap. Real-Postgres e2e covers the CHECK rewrite (PGlite divergence note).
