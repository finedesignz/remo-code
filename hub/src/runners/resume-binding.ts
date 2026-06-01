/**
 * resume-binding.ts — Phase 16 (H10 / R-PTY-31): the resume/reconnect decision
 * MUST READ the persisted runner identity and RE-BIND the same backend, never
 * re-decide the mode or spawn a second PTY.
 *
 * This is the pure decision the reconnect path calls: given the persisted
 * identity (runner_type + backend id) and whether a live backend is already
 * bound, return one of:
 *   - { action: 'rebind', runnerType, ptyBackendId }  — a PTY session with a
 *     persisted backend: re-attach to it (NO second spawn).
 *   - { action: 'spawn', runnerType }                 — first run for this
 *     session (no persisted backend yet): spawn once on the persisted mode.
 *   - { action: 'noop' }                              — a live backend is
 *     already bound; do nothing (idempotent reconnect).
 *
 * The persisted `runner_type` is AUTHORITATIVE: a pty-interactive session is
 * never resumed via the stream-json path (mis-route), and a session that already
 * has a backend is never dual-spawned.
 */
export type RunnerType = 'stream-json' | 'pty-interactive'

export interface PersistedIdentity {
  runner_type: RunnerType
  pty_backend_id: string | null
}

export type ResumeDecision =
  | { action: 'rebind'; runnerType: RunnerType; ptyBackendId: string }
  | { action: 'spawn'; runnerType: RunnerType }
  | { action: 'noop' }

/**
 * @param persisted    the DB-persisted identity (authoritative)
 * @param liveBound    true when a live backend is already attached for this session
 */
export function decideResume(persisted: PersistedIdentity, liveBound: boolean): ResumeDecision {
  // An already-bound live backend is never dual-spawned (H10).
  if (liveBound) return { action: 'noop' }
  // A PTY session WITH a persisted backend re-binds the SAME backend (no second
  // spawn, no mis-route — the persisted runner_type is authoritative).
  if (persisted.runner_type === 'pty-interactive' && persisted.pty_backend_id) {
    return { action: 'rebind', runnerType: 'pty-interactive', ptyBackendId: persisted.pty_backend_id }
  }
  // First run for this session — spawn once on the PERSISTED mode (never the
  // wrong one). A pty-interactive session spawns a PTY; a stream-json one spawns
  // the structured runner. The mode is read, not re-decided.
  return { action: 'spawn', runnerType: persisted.runner_type }
}
