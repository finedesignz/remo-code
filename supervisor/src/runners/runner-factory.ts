/**
 * runner-factory.ts — Phase 19 / 19-02 + PTY-cutover Phase A. Maps an explicit
 * human-backend id (from backend-selector) to a concrete interactive PTY
 * runner. Kept in its own module (no supervisor main() side-effects) so tests +
 * the spawn-interception harness can import it without booting the supervisor.
 *
 * The legacy/stream-json runner is unreachable here: the id type is
 * `HumanBackendId` ('claude-pty' | 'codex-pty') only.
 *
 * PRODUCTION PATH (PTY-cutover Phase A): when the Rust ConPTY host is present
 * (it wrote its loopback-port token file — detected via the resolved
 * `REMO_PTY_HOST_PORT_FILE` / LOCALAPPDATA default), this returns the Rust
 * `ClaudePtyBridge`/`CodexPtyBridge` (Option C — the genuine interactive TUI in
 * the Tauri process, no Node helper, no stream-json, EMPTY argv, API keys
 * scrubbed by the host). The Node `ClaudePtyRunner`/`CodexPtyRunner` helpers
 * remain ONLY as the explicit fallback when the port file is absent
 * (non-Windows / no Rust host). Both satisfy `PtyLike`.
 *
 * Side-effect-free (tests import it): host-presence is a pure `existsSync` on
 * the resolved port-file path — no socket connect, no spawn.
 */
import { existsSync } from 'node:fs'
import { ClaudePtyRunner } from './claude-pty-runner'
import { CodexPtyRunner } from './codex-pty-runner'
import { ClaudePtyBridge, CodexPtyBridge, resolvePtyHostPortFile } from './claude-pty-bridge'
import type { PtyLike } from './types'
import {
  resolveHumanBackend,
  type HumanBackendId,
  type BackendSelectorConfig,
  type HumanSessionContext,
} from './backend-selector'

/** True when the Rust ConPTY host has published its loopback-port token file. */
function rustPtyHostPresent(): boolean {
  try {
    return existsSync(resolvePtyHostPortFile())
  } catch {
    return false
  }
}

export function runnerForHumanBackend(id: HumanBackendId): PtyLike {
  // Production: prefer the Rust ConPTY bridge when the host is up.
  if (rustPtyHostPresent()) {
    return id === 'codex-pty' ? new CodexPtyBridge() : new ClaudePtyBridge()
  }
  // Fallback (no Rust host — non-Windows / dev): the Node PTY-host helper.
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
): PtyLike {
  const id = resolveHumanBackend(ctx, config)
  return runnerForHumanBackend(id)
}
