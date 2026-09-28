/**
 * Cloud sessions — inbound side. A claude.ai cloud session's Stop hook
 * (tools/cloud-hook/remo-cloud-stop-hook.mjs) POSTs each finished turn here; we
 * persist it as the linked remo session's assistant message and fan it out
 * exactly like an agent `assistant_message` (hub/src/ws/agent.ts).
 *
 * TRUST: the payload is written by a process inside the cloud VM. It is stored
 * and displayed as an assistant message (data), never executed or routed as an
 * instruction. Token counts only ever count AGAINST the owner's own caps.
 */
import { insertMessage, updateSessionStatus } from '../db/dal'
import { linkCloudSession } from '../db/cloud-sessions-dal.ts'
import { recordTokenUsage } from '../db/token-usage-dal.ts'
import { estimateCostUsd } from '../usage/pricing.ts'
import { broadcastToSubscribers, broadcastToUser } from '../ws/registry'
import { listSessionsForUserEnriched } from '../sessions/enrich.ts'
import { generateToken } from '../utils/token'
import { hashToken } from '../lib/crypto'

export interface CloudReplyUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface CloudReplyInput {
  userId: string
  cloudSessionId: string
  text: string
  model?: string | null
  usage?: CloudReplyUsage | null
}

const nonNeg = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

export async function ingestCloudReply(input: CloudReplyInput): Promise<{ sessionId: string; messageId: string; linked: boolean }> {
  const { userId, cloudSessionId } = input
  const name = `Cloud ${cloudSessionId.slice(-8)}`
  const session = await linkCloudSession(userId, cloudSessionId, name, await hashToken(generateToken('remo_')))

  const message = await insertMessage(session.id, 'assistant', input.text)
  broadcastToSubscribers(session.id, { type: 'message', session_id: session.id, message })

  await updateSessionStatus(session.id, 'online')
  broadcastToSubscribers(session.id, { type: 'session_status', session_id: session.id, status: 'online' })

  if (session.created) {
    try {
      broadcastToUser(userId, { type: 'session_list', sessions: await listSessionsForUserEnriched(userId) })
    } catch (err: any) {
      console.warn('[cloud-hook] session_list broadcast failed', err?.message)
    }
  }

  // Same server-side fan-out as agent.ts assistant_message.
  try {
    const { emitAssistantMessageFinal } = await import('../events/assistant-events.ts')
    emitAssistantMessageFinal({ sessionId: session.id, userId, text: input.text, messageId: (message as any)?.id })
  } catch (err: any) {
    console.warn('[cloud-hook] emitAssistantMessageFinal failed', err?.message)
  }
  try {
    const { onSessionReply } = await import('../dispatch/pipeline.ts')
    void onSessionReply(session.id, input.text)
  } catch {}
  try {
    const { clearAllPromptsPending } = await import('../ws/pending-prompts.ts')
    clearAllPromptsPending(session.id)
  } catch {}

  const u = input.usage
  if (u) {
    const counts = {
      input_tokens: nonNeg(u.input_tokens),
      output_tokens: nonNeg(u.output_tokens),
      cache_creation_input_tokens: nonNeg(u.cache_creation_input_tokens),
      cache_read_input_tokens: nonNeg(u.cache_read_input_tokens),
    }
    if (counts.input_tokens + counts.output_tokens + counts.cache_creation_input_tokens + counts.cache_read_input_tokens > 0) {
      try {
        await recordTokenUsage({
          userId,
          sessionId: session.id,
          model: input.model ?? null,
          inputTokens: counts.input_tokens,
          outputTokens: counts.output_tokens,
          cacheCreationInputTokens: counts.cache_creation_input_tokens,
          cacheReadInputTokens: counts.cache_read_input_tokens,
          costUsd: estimateCostUsd(input.model ?? null, counts),
          costSource: 'estimated',
          runnerType: 'cloud',
        })
      } catch (err: any) {
        console.warn('[cloud-hook] recordTokenUsage failed', err?.message)
      }
    }
  }

  return { sessionId: session.id, messageId: (message as any)?.id, linked: session.created }
}
