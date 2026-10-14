---
phase: PTYCAP-07-self-heal-routing
plan: 05
subsystem: hub/heal
tags: [self-heal, routing, dispatch, gates]
requires: [07-01, 07-02, 07-04]
provides: [routeHeal, resolveHealTarget, HealSink contract, runGates export]
affects: [07-06, 07-07, 07-10]
key-files:
  created:
    - hub/src/heal/resolve.ts
    - hub/src/heal/route.ts
    - hub/src/heal/prompt.ts
    - hub/src/heal/sinks/types.ts
    - hub/test/heal-resolve.test.ts
    - hub/test/heal-route-live.test.ts
    - hub/test/heal-route-guards.test.ts
  modified:
    - hub/src/dispatch/pipeline.ts
    - hub/test/counter-key-assignment-guard.test.ts
status: complete
commits: 3
plan_head_before: b736d2873691450b71e673a648f8ab247ab7920a
actuals:
  tokens: 30000
  tasks: 3
  commits: 3
---

# Phase PTYCAP-07 Plan 05: routeHeal live-dispatch path Summary

routeHeal is now the single heal seam: validated event, fail-closed recursion guard before the claim, owner-scoped ghost-aware target resolution, ledger claim, per-repo hourly bound, then dispatch through the shared pipeline with one six-gate chain; every non-live outcome terminalizes through the per-event sink.

## Commits
- 97c9c85 Task 1: resolveHealTarget (16 tests)
- 35ec0ef Task 2: routeHeal tracer, HealSink contract, prompt helper, runGates export, counter-key allowlist entry (9 tests)
- 727f22f Task 3: provenance guard, dedupe finalization, user/repo bounds, never-silent wrapper (14 tests)

## Verification (each file run in its own process)
heal-resolve 16/16, heal-route-live 9/9, heal-route-guards 14/14, token-cap-coverage 3/3, counter-key-assignment-guard 3/3, heal-flag-off 89/89, triage-routing 4/4, error-capture-dispatch 1/1, orchestrator-autospawn-inject 14/14. tsc: no errors in touched files. Forbidden-identifier grep under hub/src/heal prints nothing; exactly one `gates:` literal (route.ts); pipeline.ts diff is the single `export` keyword.

## Decisions
- Real collaborators in REAL_DEPS are lazy imports (DAL, sink index) so importing route.ts/resolve.ts never loads the DB; the default sink factory resolves `./sinks/index.ts` (created by 07-07) at call time.
- Provenance probe error returns `refused:heal_guard_error` but terminalizes the sink with `failed` (metadata run must end failed per plan); provenance hit returns/terminalizes `refused:heal_provenance`.
- Capped-user test patches the real gate objects' `check` in place (restored in afterAll) and runs the real `dispatch()`, avoiding process-global mock.module.

## Deviations from Plan
None - plan executed as written. Notes: the plan's Task 2 verify command runs five test files in one process; they pass individually but a combined single-process run shows 3 failures from the known Bun mock.module cross-file pollution (project QC runs each file in its own process), so verification was run per file. Spies for launch/supervisor-frame/online-lister are enforced by a source scan of hub/src/heal (no such identifiers) because dispatch and all collaborators are injected and cannot reach them.

## Known Stubs
None. Autospawn, notifications and sources are deliberately later plans (07-06, 07-07); offline candidates currently terminalize as `no_routable_session`.

## Threat Flags
None.

## Self-Check: PASSED
Created files exist; commits 97c9c85, 35ec0ef, 727f22f present.
