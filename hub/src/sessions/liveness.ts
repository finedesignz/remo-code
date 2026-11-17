// hub/src/sessions/liveness.ts
// PTYCAP-07-04 (D-03): the ghost-aware session liveness predicate, MOVED verbatim from the
// orchestrator inject seam so the orchestrator and the self-heal path share ONE definition.
import { getChannel } from '../ws/registry.ts'

/**
 * Default liveness check: a session is live only if it has a live agent channel
 * AND is not a ghost. A ghost is `status='online' AND hostname IS NULL` (a
 * phantom channel from a hostname-less re-auth). On any DB error we fail OPEN to
 * "live" (channel present => preserve the legacy dispatch behaviour for genuine
 * sessions rather than mis-route them to autospawn on a transient read error).
 */
export async function isSessionLive(sessionId: string): Promise<boolean> {
  if (getChannel(sessionId) == null) return false
  try {
    const { sql } = await import('../db/postgres.ts')
    const rows = await sql<{ status: string | null; hostname: string | null }[]>`
      SELECT status, hostname FROM sessions WHERE id = ${sessionId} AND deleted_at IS NULL LIMIT 1
    `
    const row = rows[0]
    if (!row) return true // channel present but no row - treat as live (best-effort)
    const isGhost = row.status === 'online' && row.hostname == null
    return !isGhost
  } catch {
    return true // fail-open to live - never mis-route a genuine session on a read error
  }
}
