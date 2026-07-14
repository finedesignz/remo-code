/**
 * Hub → supervisor read RPC (milestone ASK, Phase 1).
 *
 * Issues an allowlisted `run_command` on a supervisor and awaits its
 * `run_finished` frame, correlating by a synthetic run id. The supervisor's
 * run-event fan-in (`hub/src/ws/agent.ts`) calls `handleExtRunEvent` alongside the
 * scheduler + TEAB handlers; each ignores run ids it does not own.
 *
 * READ-ONLY by construction: the only commands routed here are
 * `session_transcript_tail` / `session_memory`, both of which the supervisor
 * implements as pure reads of the CLI's own project dir (see
 * supervisor/src/commands/session-read.ts — the path-traversal chokepoint lives
 * THERE, on the host, not here).
 */
import { randomUUID } from 'crypto'
import { getSupervisor } from '../ws/supervisor-registry.ts'

/** Commands this seam may issue. Anything else is refused (fail closed). */
export const EXT_READ_COMMANDS = ['session_transcript_tail', 'session_memory'] as const
export type ExtReadCommand = (typeof EXT_READ_COMMANDS)[number]

export interface ExtCommandResult {
  exit_code: number
  snippet?: string
  error?: string
}

interface Pending {
  supervisorId: string
  userId: string
  resolve: (r: ExtCommandResult) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

/** Test hook. */
export function _resetExtPending(): void {
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
}

export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Run an allowlisted READ command on a supervisor. Never throws: every failure
 * (offline supervisor, unknown command, timeout) comes back as a non-zero
 * `exit_code` + `error`.
 */
export async function runSupervisorReadCommand(
  supervisorId: string,
  userId: string,
  command: ExtReadCommand,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExtCommandResult> {
  if (!(EXT_READ_COMMANDS as readonly string[]).includes(command)) {
    return { exit_code: 1, error: 'command_not_allowed' }
  }
  const entry = getSupervisor(supervisorId)
  if (!entry) return { exit_code: 1, error: 'supervisor_offline' }

  const runId = `extread_${randomUUID()}`
  return await new Promise<ExtCommandResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(runId)
      resolve({ exit_code: 1, error: 'supervisor_timeout' })
    }, timeoutMs)
    pending.set(runId, { supervisorId, userId, resolve, timer })
    try {
      entry.ws.send(JSON.stringify({ type: 'run_command', run_id: runId, command, args }))
    } catch (err: any) {
      clearTimeout(timer)
      pending.delete(runId)
      resolve({ exit_code: 1, error: `supervisor_send_failed: ${err?.message ?? err}` })
    }
  })
}

/**
 * Fan-in from the supervisor run-event branch. Ignores run ids we don't own (the
 * scheduler + TEAB handlers do the same), so calling all three is safe.
 */
export function handleExtRunEvent(supervisorId: string, userId: string, msg: any): void {
  if (msg?.type !== 'run_finished') return
  const p = pending.get(msg.run_id)
  if (!p) return
  if (p.supervisorId !== supervisorId || p.userId !== userId) return
  clearTimeout(p.timer)
  pending.delete(msg.run_id)
  p.resolve({
    exit_code: typeof msg.exit_code === 'number' ? msg.exit_code : 1,
    snippet: msg.snippet,
    error: msg.error,
  })
}

/** Parse a supervisor snippet as JSON. Returns null on any failure. */
export function parseSnippet<T>(res: ExtCommandResult): T | null {
  if (res.exit_code !== 0 || !res.snippet) return null
  try {
    return JSON.parse(res.snippet) as T
  } catch {
    return null
  }
}
