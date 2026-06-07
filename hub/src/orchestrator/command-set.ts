// hub/src/orchestrator/command-set.ts
// Phase 31 — the SPEC §3 user-configurable orchestrator command set (single
// source of truth for the API validator + the web UI's "+ Add command" picker).
//
// The two always-on IMPLICIT rows (status-check/decide first, deploy+log-verify
// terminal) are NOT here — they are not user-configurable rows. `micro_prompt`
// rows are free-text and validated separately (any command label allowed when a
// micro_prompt body is present).

export const ORCHESTRATOR_COMMANDS = [
  'gsd-plan-phase',
  'gsd-execute-phase',
  'gsd-audit-fix',
  'gap-scan',
  'gsd-code-review',
  'gsd-verify-work',
  'gsd-complete-milestone',
  'gsd-ship',
  'merge-to-main',
] as const;

export type OrchestratorCommand = (typeof ORCHESTRATOR_COMMANDS)[number];

const KNOWN = new Set<string>(ORCHESTRATOR_COMMANDS);

export function isKnownCommand(cmd: string): boolean {
  return KNOWN.has(cmd);
}
