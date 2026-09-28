/**
 * Cloud sessions — queue one message into a claude.ai cloud session:
 *
 *   <content on stdin> | claude -p --cloud <cloud_session_id> --output-format json
 *
 * The CLI queues the message and exits without waiting for the reply
 * (https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli);
 * the reply returns to the hub through the cloud session's Stop hook. The content
 * travels on STDIN (documented form), never argv, so a message starting with `-`
 * can't be read as a flag and Windows' command-line length limit doesn't apply.
 *
 * `--cloud` authenticates with the host's claude.ai login, so the spawn env goes
 * through the shared scrubber (no provider API key, no deploy credential).
 */
import { homedir } from 'node:os'
import { sanitizeSpawnEnv } from '../runners/env-sanitize'

export const CLOUD_SESSION_ID_RE = /^(cse|session)_[A-Za-z0-9_-]{1,128}$/
export const CLOUD_SEND_TIMEOUT_MS = 45_000
export const CLOUD_SEND_MAX_CHARS = 100_000

export type CloudSendOutcome = { ok: true } | { ok: false; error: string }

type SpawnFn = (opts: {
  cmd: string[]
  cwd: string
  env: Record<string, string | undefined>
  stdin: 'pipe'
  stdout: 'pipe'
  stderr: 'pipe'
  windowsHide: boolean
}) => {
  stdin: { write(s: string): unknown; end(): unknown }
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(): void
}

export interface CloudSendDeps {
  spawn: SpawnFn
  env: () => Record<string, string | undefined>
  timeoutMs: number
}

const defaultDeps: CloudSendDeps = {
  spawn: (opts) => Bun.spawn(opts) as any,
  env: () => sanitizeSpawnEnv({ ...process.env }, { scrubDeployCredentials: true, scrubGitPush: true }),
  timeoutMs: CLOUD_SEND_TIMEOUT_MS,
}

export function cloudSendArgv(cloudSessionId: string): string[] {
  return ['claude', '-p', '--cloud', cloudSessionId, '--output-format', 'json']
}

/** Pull the CLI's `{ok, error}` out of stdout; tolerate leading noise lines. */
export function parseCloudSendOutput(stdout: string): { ok: boolean; error?: string } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]!)
      if (j && typeof j === 'object' && typeof j.ok === 'boolean') {
        return { ok: j.ok, error: typeof j.error === 'string' ? j.error : undefined }
      }
    } catch {}
  }
  return null
}

export async function runCloudSend(
  cloudSessionId: string,
  content: string,
  deps: CloudSendDeps = defaultDeps,
): Promise<CloudSendOutcome> {
  if (!CLOUD_SESSION_ID_RE.test(cloudSessionId)) return { ok: false, error: 'invalid_cloud_session_id' }
  if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'empty_message' }
  if (content.length > CLOUD_SEND_MAX_CHARS) return { ok: false, error: 'message_too_long' }

  let proc: ReturnType<SpawnFn>
  try {
    proc = deps.spawn({
      cmd: cloudSendArgv(cloudSessionId),
      cwd: homedir(),
      env: deps.env(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
  } catch (err: any) {
    return { ok: false, error: `spawn_failed: ${err?.message ?? err}` }
  }
  try {
    proc.stdin.write(content)
    proc.stdin.end()
  } catch {}

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { proc.kill() } catch {} }, deps.timeoutMs)
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (timedOut) return { ok: false, error: 'cloud_send_timeout' }
    const parsed = parseCloudSendOutput(out)
    if (parsed?.ok) return { ok: true }
    // Config errors print to stderr without JSON (docs: "Output and errors").
    const reason = parsed?.error || err.trim().replace(/^Error:\s*/, '') || `claude exited ${code}`
    return { ok: false, error: reason.slice(0, 1900) }
  } finally {
    clearTimeout(timer)
  }
}
