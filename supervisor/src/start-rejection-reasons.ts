// supervisor/src/start-rejection-reasons.ts
//
// 2026-08-18 QC round 3 (R3-2) — dependency-free leaf module. Deliberately
// has ZERO imports.
//
// This used to live in process-manager.ts, which hub/test/supervisor-stopped-
// recovery.test.ts imported directly so its lock-step assertion could derive
// from the real source instead of a hand-copied literal (round-two follow-
// up). That worked functionally, but process-manager.ts sits at the CENTER
// of the supervisor's runtime graph — `hub/tsconfig.json` includes `"test"`,
// so that import pulled the supervisor's entire transitive dependency graph
// (sandbox, audit, session-bridge -> claude-runner, runner-factory,
// pty-persistence, ...) into what the hub's tsconfig typechecks. Measured:
// +10 tsc errors on the branch vs `main`, all inside
// `supervisor/src/runners/claude-runner.ts`, now counted against the HUB.
// Harmless today only because `.woodpecker/qc.yaml:40` still swallows the
// typecheck step with `|| echo` — and the comment on that line says the step
// was just made real, i.e. this was about to start actually failing CI.
//
// The precedent this was modeled on (git-introspect.ts importing hub's
// `repo-key.ts`) is NOT the same shape: `repo-key.ts` is itself a
// dependency-free leaf. `process-manager.ts` is not. A leaf module on THIS
// side of the boundary is what actually matches that precedent — hence this
// file. `process-manager.ts` re-exports `START_REJECTION_REASONS` from here
// (single source of truth stays a single array, just moved to a leaf) so
// nothing else in the supervisor needs to change its import path.

/**
 * Every reason `ProcessManager.start()` can return in a `StartRejection`.
 * Source of truth for `StartRejection.reason` (see process-manager.ts) AND
 * for `hub/src/ws/agent.ts`'s `SUPERVISOR_START_REJECT_REASONS`, which MUST
 * stay in lock-step with this set — a reason missing there is treated as a
 * real supervisor-lifecycle stop instead of a per-run rejection (the
 * 2026-05-28 prod bug `SUPERVISOR_START_REJECT_REASONS` exists to prevent).
 * `hub/test/supervisor-stopped-recovery.test.ts` imports this array directly
 * so drift in EITHER direction (a hub-side deletion or a supervisor-side
 * addition) fails that test immediately instead of silently diverging.
 */
export const START_REJECTION_REASONS = [
  // 2026-08-18 (repo_path placeholder investigation) — 'sandbox_escape' split
  // into three finer reasons so a denial in supervisor/audit.jsonl is
  // self-diagnosing without needing the live supervisor.json at that moment.
  // See supervisor/src/sandbox.ts SandboxEscapeKind for what distinguishes
  // them. All three are per-run rejections, same lock-step requirement as
  // the reason they replace.
  'sandbox_path_missing',
  'sandbox_not_under_roots',
  'sandbox_roots_unresolvable',
  'sandbox_check_timeout',
  'not_git_repo',
  'concurrency_cap',
  'duplicate_run',
  'legacy_agent_spawn_disabled',
  'circuit_open',
] as const

export type StartRejectionReason = (typeof START_REJECTION_REASONS)[number]
