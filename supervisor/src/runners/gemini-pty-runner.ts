/**
 * gemini-pty-runner.ts — Phase 19 / 19-03 (R-PTY-23). STUBBED FUTURE SEAM ONLY.
 *
 * WHY A STUB, NOT A WORKING BACKEND (19-RESEARCH.md, CONFIDENCE: HIGH):
 *   Gemini CLI + Gemini Code Assist STOP serving the individual / Google AI Pro /
 *   Google AI Ultra tiers starting JUNE 18 2026, migrating to the Antigravity CLI
 *   with tighter WEEKLY quotas (down from Gemini CLI's ~1,000-request daily free
 *   tier). Gemini is therefore NOT a reliable fallback for a remote-coding
 *   workflow. This seam exists so a FUTURE viable backend (possibly Antigravity,
 *   once quotas/tiers settle) slots into the backend-agnostic PTY surface without
 *   re-architecting. RE-VERIFY post-June-18-2026 before any real wiring.
 *
 * HARD INVARIANTS (carried even though the runner throws):
 *   - Feature-flagged OFF; NEVER default-selected by the backend selector.
 *   - Explicit selection surfaces a clear "not available" error — it never
 *     partially works on a sunsetting tier.
 *   - If ever implemented, it MUST spawn the interactive TUI with EMPTY argv (no
 *     -p / --print / --input-format / --output-format / stream-json) and route
 *     its spawn env through the shared `sanitizeSpawnEnv` (no provider API key —
 *     GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_APPLICATION_CREDENTIALS are on the
 *     denylist). No API-key path, ever.
 */
import { sanitizeSpawnEnv } from './env-sanitize'

/** Feature flag — OFF. Flipping this true alone does NOT make Gemini work; the
 *  runner is unimplemented. The flag exists only to document the seam state. */
export const GEMINI_BACKEND_ENABLED = false as const

export const GEMINI_NOT_AVAILABLE_MESSAGE =
  'Gemini backend not available: stubbed future seam only ' +
  '(Gemini CLI/Code Assist individual/Pro/Ultra tiers sunset June 18 2026 → ' +
  'Antigravity weekly quotas; re-verify before real wiring). No API-key fallback.'

export interface PtyRunnerOpts {
  cwd: string
  cols?: number
  rows?: number
  onData: (bytes: string) => void
  onExit?: (code: number | null) => void
}

/**
 * Build the env a future Gemini PTY host would receive. Routed through the shared
 * sanitizer so the no-API-key invariant holds the moment this is ever wired.
 * Exported for the env-guard test even though `start()` throws today.
 */
export function buildGeminiPtyHostEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return sanitizeSpawnEnv(base)
}

/**
 * Stubbed Gemini PTY runner. Conforms to the raw-bytes PTY runner shape so a
 * future backend slots in, but `start()` throws a clear not-available error.
 */
export class GeminiPtyRunner {
  start(_opts: PtyRunnerOpts): void {
    throw new Error(GEMINI_NOT_AVAILABLE_MESSAGE)
  }

  write(_data: string): void {
    throw new Error(GEMINI_NOT_AVAILABLE_MESSAGE)
  }

  resize(_cols: number, _rows: number): void {
    /* no-op: never spawned */
  }

  kill(): void {
    /* no-op: never spawned */
  }

  get pid(): number | undefined {
    return undefined
  }
}
