/**
 * Cloud sessions — outbound side. Queues a user message into a claude.ai cloud
 * session by asking an online supervisor to run
 *   claude -p <content> --cloud <cloud_session_id> --output-format json
 * (supervisor/src/commands/cloud-send.ts). The CLI only QUEUES the message; the
 * reply comes back through the cloud session's Stop hook → POST /api/cloud-hook/reply.
 *
 * Gates: the non-bypassable daily cost cap AND token cap run before anything is
 * sent (CLAUDE.md invariant). Cloud turns report usage via the hook, so they
 * accrue against the same caps.
 */
import type { DispatchGate, DispatchRequest } from '../dispatch/pipeline.ts'
import { dailyCostCapGate, dailyTokenCapGate } from '../dispatch/gates.ts'
import { listOnlineSupervisorIdsForUser, sendRequest } from '../ws/supervisor-registry.ts'
import { isCloudSessionId } from '../db/cloud-sessions-dal.ts'

/** The CLI returns within seconds; allow for a slow host + cloud API. */
export const CLOUD_SEND_TIMEOUT_MS = 60_000

export type CloudSendResult =
  | { ok: true; supervisorId: string }
  | { ok: false; error: 'gate_blocked' | 'no_supervisor' | 'cloud_send_failed' | 'invalid_cloud_session_id'; reason: string }

export interface CloudSendDeps {
  gates: DispatchGate[]
  listSupervisors: (userId: string) => string[]
  request: (supervisorId: string, msg: Record<string, unknown>, timeoutMs: number) => Promise<unknown>
}

export const defaultCloudSendDeps: CloudSendDeps = {
  gates: [dailyCostCapGate, dailyTokenCapGate],
  listSupervisors: listOnlineSupervisorIdsForUser,
  request: (id, msg, t) => sendRequest(id, msg as any, t),
}

export async function sendToCloudSession(
  req: { userId: string; sessionId: string; cloudSessionId: string; content: string; token: string },
  deps: CloudSendDeps = defaultCloudSendDeps,
): Promise<CloudSendResult> {
  if (!isCloudSessionId(req.cloudSessionId)) {
    return { ok: false, error: 'invalid_cloud_session_id', reason: 'Linked cloud session id is malformed.' }
  }
  const dreq: DispatchRequest = { userId: req.userId, sessionId: req.sessionId, token: req.token, prompt: req.content }
  for (const g of deps.gates) {
    const r = await g.check(dreq)
    if (!r.ok) return { ok: false, error: 'gate_blocked', reason: r.reason }
  }

  const sups = deps.listSupervisors(req.userId)
  if (sups.length === 0) {
    return { ok: false, error: 'no_supervisor', reason: 'No supervisor is online to relay the message to the cloud session.' }
  }
  // Any of the user's supervisors can send (the CLI authenticates with the host's
  // claude.ai login). A CLI-level rejection (ok:false) is final; a transport
  // failure (offline / timeout / old supervisor without the handler) tries the next.
  let lastErr = 'no supervisor answered'
  for (const supervisorId of sups) {
    try {
      await deps.request(
        supervisorId,
        { type: 'cloud_session.send', cloud_session_id: req.cloudSessionId, content: req.content },
        CLOUD_SEND_TIMEOUT_MS,
      )
      return { ok: true, supervisorId }
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (msg !== 'supervisor offline' && msg !== 'supervisor request timed out') {
        return { ok: false, error: 'cloud_send_failed', reason: msg }
      }
      lastErr = msg
    }
  }
  return { ok: false, error: 'cloud_send_failed', reason: lastErr }
}
