/**
 * runner-factory.ts — Phase 19 / 19-02. Maps an explicit human-backend id
 * (from backend-selector) to a concrete PTY runner instance. Kept in its own
 * module (no supervisor main() side-effects) so tests + the spawn-interception
 * harness can import it without booting the supervisor.
 *
 * The legacy/stream-json runner is unreachable here: the id type is
 * `HumanBackendId` ('claude-pty' | 'codex-pty') only.
 */
import { ClaudePtyRunner } from './claude-pty-runner'
import { CodexPtyRunner } from './codex-pty-runner'
import {
  resolveHumanBackend,
  type HumanBackendId,
  type BackendSelectorConfig,
  type HumanSessionContext,
} from './backend-selector'

export function runnerForHumanBackend(id: HumanBackendId): ClaudePtyRunner | CodexPtyRunner {
  return id === 'codex-pty' ? new CodexPtyRunner() : new ClaudePtyRunner()
}

/**
 * Phase-19 gated human-session backend selection (R-PTY-22). Resolves the
 * cutover-gate-aware backend id, then instantiates the matching PTY runner.
 * Throws for a non-human ctx or any non-PTY/legacy resolution (fail-closed).
 * Automation does NOT use this — it routes through the dispatch pipeline.
 */
export function selectHumanPtyRunner(
  ctx: HumanSessionContext,
  config: BackendSelectorConfig,
): ClaudePtyRunner | CodexPtyRunner {
  const id = resolveHumanBackend(ctx, config)
  return runnerForHumanBackend(id)
}
