/**
 * Phase 20 — transcript source selection.
 *
 * `selectAdapter(cliKind)` returns the backend-specific `TranscriptSource`. The
 * bridge (plan 02) + permission detector (plan 03) consume ONLY the
 * `TranscriptEntry` union — they never branch on backend. This module is the one
 * place `cliKind` maps to an implementation.
 */

import type { CliKind, TranscriptSource } from './types.ts'
import { ClaudeTranscriptAdapter } from './claude-adapter.ts'
import { CodexTranscriptAdapter } from './codex-adapter.ts'

export * from './types.ts'

/**
 * Pick the adapter for a session's backend. A fresh instance per call: each open
 * session tails its own file with its own watcher/timer state, so adapters are
 * NOT shared singletons.
 */
export function selectAdapter(cliKind: CliKind): TranscriptSource {
  return cliKind === 'codex' ? new CodexTranscriptAdapter() : new ClaudeTranscriptAdapter()
}
