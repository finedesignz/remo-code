/**
 * Target resolver (W2/T7).
 *
 * Given a task + userId, returns the list of dispatch targets with their
 * socket handles (if online). The dispatcher uses these to pick a sender
 * and either ship immediately or hold for grace.
 */
import type { ServerWebSocket } from 'bun'
import type { ScheduledTask, TargetKind } from '../db/scheduled-tasks-dal.ts'
import { sql } from '../db/postgres.ts'
import { getChannel } from '../ws/registry.ts'
import {
  getSupervisor,
  listOnlineSupervisorIdsForUser,
} from '../ws/supervisor-registry.ts'

export interface ResolvedTarget {
  kind: TargetKind
  sessionId?: string | null
  supervisorId?: string | null
  agentSocket?: ServerWebSocket<any> | null
  supervisorSocket?: ServerWebSocket<any> | null
  online: boolean
}

export async function resolveTargets(
  task: ScheduledTask,
  userId: string,
): Promise<ResolvedTarget[]> {
  const kind = task.target_kind
  switch (kind) {
    case 'session': {
      const sid = task.target_id || task.session_id
      if (!sid) return []
      const ch = getChannel(sid)
      return [{
        kind: 'session',
        sessionId: sid,
        agentSocket: ch?.ws ?? null,
        online: !!ch,
      }]
    }
    case 'supervisor': {
      const sup = task.target_id
      if (!sup) return []
      const entry = getSupervisor(sup)
      return [{
        kind: 'supervisor',
        supervisorId: sup,
        supervisorSocket: entry?.ws ?? null,
        online: !!entry,
      }]
    }
    case 'all_agents': {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM sessions WHERE user_id = ${userId} AND deleted_at IS NULL
      `
      const out: ResolvedTarget[] = []
      for (const r of rows) {
        const ch = getChannel(r.id)
        if (ch) {
          out.push({
            kind: 'all_agents',
            sessionId: r.id,
            agentSocket: ch.ws,
            online: true,
          })
        }
      }
      return out
    }
    case 'all_supervisors': {
      const ids = listOnlineSupervisorIdsForUser(userId)
      return ids
        .map((id) => {
          const entry = getSupervisor(id)
          if (!entry) return null
          return {
            kind: 'all_supervisors' as TargetKind,
            supervisorId: id,
            supervisorSocket: entry.ws,
            online: true,
          }
        })
        .filter((x): x is ResolvedTarget => x !== null)
    }
    default:
      return []
  }
}
