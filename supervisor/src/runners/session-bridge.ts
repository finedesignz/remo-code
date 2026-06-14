import { hostname, platform, release, arch, cpus, totalmem, tmpdir } from 'os'
import { mkdirSync, writeFileSync } from 'fs'
import { join, basename, extname } from 'path'
import { ClaudeRunner } from './claude-runner'
import { selectHumanPtyRunner } from './runner-factory'
import { PtyPersistence } from './pty-persistence'
import { getBackendSelectorConfig } from '../config'
import type { AgentToHub, CliRunner, HubToAgent, PtyLike, RunnerEvent } from './types'

/**
 * Module-level supervisor-owned PTY persistence coordinator (R-PTY-07/27).
 * Tracks the interactive PTY per remo-session so a dropped browser/phone WS
 * detaches (not kills) and a reattach replays scrollback. Shared across all
 * SessionBridge instances in this process.
 */
const ptyPersistence = new PtyPersistence()

/**
 * Phase-15 spike flag. When `REMO_PTY_INTERACTIVE=1`, a session hosts the
 * raw-terminal interactive `claude` PTY runner instead of the stream-json
 * ClaudeRunner, bridging onData → `term.data` frames and routing inbound
 * `term.input`/`term.resize` to the PTY. ADDITIVE + flag-gated — the stream-json
 * path is untouched when the flag is off. Full per-session runner-type selection
 * is Phase 16 (this is the spike seam, not the production switch).
 */
function ptyInteractiveEnabled(): boolean {
  return process.env.REMO_PTY_INTERACTIVE === '1'
}

/**
 * Make an upload filename safe to write into a temp dir: strip any path
 * components and traversal, drop control chars, and keep a sane extension.
 * Never returns an empty string. Exported for unit testing.
 */
export function sanitizeAttachmentName(raw: string): string {
  // basename() defeats path separators on both platforms; then strip anything
  // that isn't a conservative filename char, collapse dots so `..` can't survive.
  let name = basename(String(raw || ''))
  const ext = extname(name).slice(0, 16) // bound the extension length
  const stem = name.slice(0, name.length - ext.length)
  const cleanStem = stem.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.+/g, '.').replace(/^\.+/, '')
  const cleanExt = ext.replace(/[^A-Za-z0-9.]/g, '')
  name = (cleanStem || 'attachment') + cleanExt
  return name.slice(0, 200)
}

/**
 * Per-session WebSocket bridge to the hub's `/ws/agent` endpoint. Restored
 * 2026-05-27 to replace the retired external npm agent that used to do this
 * work in its own subprocess.
 *
 * Design notes:
 *   - One bridge instance per `session.start` run. Each bridge opens an
 *     independent WS to /ws/agent and authenticates with `project_dir = repoPath`
 *     and `role = 'agent'` so the hub binds it to the right session row.
 *   - The runner (Claude CLI subprocess) is owned by the bridge — runner
 *     events are translated to the hub's agent-protocol shapes and forwarded.
 *   - The hub's `user_message`, `permission_response`, `question_response`,
 *     `cancel`, and `shutdown` are routed back into the runner.
 *   - This bridge is COMPLETELY SEPARATE from `SupervisorClient`'s WS (which
 *     uses `project_dir = '__supervisor__'`). The hub keys agent vs supervisor
 *     channels by the auth payload, so the two coexist on the same TCP host.
 */

export interface SessionBridgeCallbacks {
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void
  /** Bridge exited (runner died, hub auth rejected, or WS closed beyond retry). */
  onExit: (info: { code: number | null; reason: string }) => void
  /** Runner spawned successfully and reported its pid. */
  onSpawned: (info: { pid: number }) => void
  /** Bug A — hub returned a session_id after auth; let ProcessManager stamp
   *  it onto the run so the next session_inventory push carries it. */
  onSessionId?: (sessionId: string) => void
  /** Bug A — outbound runner event observed; bump last_activity_at. */
  onActivity?: () => void
}

export interface SessionBridgeOptions {
  runId: string
  repoPath: string
  apiKey: string
  hubUrl: string
  allowDangerousSkipPermissions: boolean
  /**
   * When set, the bridge spawns Claude with the orchestrator-specific env
   * (REMO_HUB_API_KEY, REMO_HUB_URL) and writes a `.remo-orchestrator.md`
   * system-prompt file into cwd that Claude picks up via CLAUDE.md-style
   * convention.
   */
  orchestrator?: {
    systemPrompt: string
    hubApiKey: string
    hubUrl: string
  }
  /** Test hook — when set, used instead of `new WebSocket()`. */
  wsFactory?: (url: string) => WebSocket
  /** Test hook — when set, used instead of `new ClaudeRunner()`. */
  runnerFactory?: (repoPath: string, allowDangerous: boolean, orchestrator?: SessionBridgeOptions['orchestrator']) => CliRunner
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]

export class SessionBridge {
  private ws: WebSocket | null = null
  private runner: CliRunner | null = null
  /** Interactive PTY runner (mutually exclusive with `runner`, active only under
   *  REMO_PTY_INTERACTIVE=1). Raw bytes only — never emits RunnerEvent.
   *  PTY-cutover Phase A: this is the Rust ConPTY `ClaudePtyBridge` in prod
   *  (Option C), or the Node `ClaudePtyRunner` fallback when no Rust host —
   *  both satisfy `PtyLike`, chosen by the gated runner-factory. */
  private ptyRunner: PtyLike | null = null
  private sessionId: string | null = null
  private opts: SessionBridgeOptions
  private cb: SessionBridgeCallbacks
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private spawnReported = false

  constructor(opts: SessionBridgeOptions, cb: SessionBridgeCallbacks) {
    this.opts = opts
    this.cb = cb
  }

  start() {
    this.connect()
  }

  /**
   * Liveness probe for the supervisor's slot reconciler. True while this bridge
   * is genuinely occupying a concurrency slot: it has an open hub WS OR a live
   * runner subprocess. A bridge that is permanently stranded (hub auth bounce /
   * hub down — stuck in the reconnect-backoff loop with no runner) reports false
   * between reconnect attempts, letting ProcessManager.reconcileSlots() reclaim
   * the leaked slot. A healthy session that is briefly mid-reconnect still has a
   * live runner, so it keeps reporting true and is never reclaimed.
   */
  isAlive(): boolean {
    if (this.stopped) return false
    if (this.ws?.readyState === WebSocket.OPEN) return true
    if (this.runner) return true
    if (this.ptyRunner) return true
    return false
  }

  /**
   * True once a runner subprocess has actually been spawned (onSpawned fired).
   * The slot reconciler uses THIS — not the run's stored pid — to decide whether
   * a counted slot is genuinely occupying a process. The stream-json runner
   * reports spawn with a best-effort `pid: 0` (it never surfaces a real OS pid
   * through its `ready` event), which ProcessManager stores as `null`; basing
   * aliveness on `pid != null` therefore reaps every healthy idle session
   * (#237 regression). `spawnReported` is the truthful signal: a bridge that
   * authenticated (WS open) but never spawned a runner returns false and stays
   * reclaimable; a bridge that has spawned and is alive returns true forever.
   */
  hasSpawnedRunner(): boolean {
    return this.spawnReported
  }

  /** Stop runner + close WS. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.runner) {
      try { await this.runner.stopGracefully() } catch {}
      this.runner = null
    }
    // Session close = KILL the PTY (R-PTY-27). Route through the persistence
    // coordinator so it drops its registry entry + scrollback; fall back to a
    // direct kill if the session was never registered.
    if (this.ptyRunner) {
      if (this.sessionId) { try { ptyPersistence.kill(this.sessionId, 'session_close') } catch {} }
      try { this.ptyRunner.kill() } catch {}
      this.ptyRunner = null
    }
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
  }

  private connect() {
    if (this.stopped) return
    const url = this.opts.hubUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws/agent'
    this.cb.onLog('info', `agent-bridge: connecting to ${url}`)
    let ws: WebSocket
    try {
      ws = this.opts.wsFactory ? this.opts.wsFactory(url) : new WebSocket(url)
    } catch (err: any) {
      this.cb.onLog('error', `agent-bridge: ws construct failed: ${err?.message ?? err}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.reconnectAttempt = 0
      const repoSlash = this.opts.repoPath.replace(/\\/g, '/')
      const cpuList = cpus()
      const auth: AgentToHub = {
        type: 'auth',
        api_key: this.opts.apiKey,
        project_dir: repoSlash,
        hostname: hostname(),
        role: 'agent',
        agent_info: {
          hostname: hostname(),
          platform: platform(),
          os_release: release(),
          arch: arch(),
          cpu_model: cpuList[0]?.model,
          cpu_cores: cpuList.length,
          total_mem_bytes: totalmem(),
          node_version: process.versions.node,
          bun_version: (process.versions as any).bun,
          agent_version: 'supervisor-inproc',
        },
      }
      try { ws.send(JSON.stringify(auth)) } catch (err: any) {
        this.cb.onLog('error', `agent-bridge: auth send failed: ${err?.message ?? err}`)
      }
    }

    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      let msg: HubToAgent
      try {
        const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as any)
        msg = JSON.parse(raw) as HubToAgent
      } catch { return }
      this.handleHubMessage(msg)
    }

    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      const code = (ev as any)?.code as number | undefined
      this.cb.onLog('warn', `agent-bridge: ws closed code=${code ?? '?'}`)
      this.ws = null
      if (this.stopped) return
      // Terminal-ish auth failures — surface as bridge exit; don't retry forever.
      if (code === 4001 || code === 4002) {
        this.cb.onLog('error', `agent-bridge: terminal close code=${code}; bridge exiting`)
        if (this.runner) { try { this.runner.stop() } catch {} this.runner = null }
        if (this.ptyRunner) { try { this.ptyRunner.kill() } catch {} this.ptyRunner = null }
        this.cb.onExit({ code: null, reason: `ws_close_${code}` })
        return
      }
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose follows
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return
    if (this.reconnectTimer) return
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]
    this.reconnectAttempt++
    this.cb.onLog('info', `agent-bridge: reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private handleHubMessage(msg: HubToAgent) {
    if (msg.type === 'ping') {
      this.sendToHub({ type: 'pong' })
      return
    }
    if (msg.type === 'auth_ok') {
      this.sessionId = msg.session_id
      this.cb.onLog('info', `agent-bridge: authenticated session=${this.sessionId.slice(0, 8)}`)
      try { this.cb.onSessionId?.(this.sessionId) } catch {}
      if (ptyInteractiveEnabled()) this.ensurePtyRunner()
      else this.ensureRunner()
      return
    }
    if (msg.type === 'auth_error') {
      this.cb.onLog('error', `agent-bridge: auth_error: ${msg.error}`)
      // hub will close; onclose handles retries unless terminal
      return
    }
    if (!this.sessionId) return

    // --- Raw-terminal channel (Phase 15) — additive, flag-gated. term.* frames
    // are raw bytes routed straight to the PTY runner; they NEVER touch the
    // stream-json runner or RunnerEvent translation. ---
    if (ptyInteractiveEnabled()) {
      const anyMsg = msg as any
      if (anyMsg.type === 'term.input') {
        const pty = this.ensurePtyRunner()
        try { pty?.write(Buffer.from(String(anyMsg.bytes ?? ''), 'base64').toString('binary')) } catch {}
        return
      }
      if (anyMsg.type === 'term.resize') {
        this.ptyRunner?.resize(Number(anyMsg.cols) || 80, Number(anyMsg.rows) || 24)
        return
      }
      if (anyMsg.type === 'term.attach') {
        this.ensurePtyRunner()
        return
      }
      if (anyMsg.type === 'term.attach_file') {
        // Write the uploaded bytes to a per-session temp file on THIS host, then
        // type the absolute path into the TUI so Claude/Codex can read it. The
        // browser has no filesystem on the host; this is the path-injection seam.
        try {
          const pty = this.ensurePtyRunner()
          const safe = sanitizeAttachmentName(String(anyMsg.filename ?? 'attachment'))
          const dir = join(tmpdir(), 'remo-attachments', this.sessionId)
          mkdirSync(dir, { recursive: true })
          const abs = join(dir, safe)
          const bytes = Buffer.from(String(anyMsg.data_b64 ?? ''), 'base64')
          writeFileSync(abs, bytes)
          // Trailing space so the path is a complete token at the TUI cursor.
          pty?.write(abs + ' ')
          this.cb.onLog('info', `term.attach_file: wrote ${bytes.length}B → ${abs}`)
        } catch (err) {
          this.cb.onLog('error', `term.attach_file failed: ${(err as Error)?.message ?? err}`)
        }
        return
      }
    }

    if (msg.type === 'user_message') {
      const runner = this.ensureRunner()
      if (!runner) return
      const sendIt = () => {
        let prompt = ''
        if (msg.attachments?.length) {
          for (const att of msg.attachments) {
            prompt += `[Attached file: ${att.filename}]\n${att.content}\n\n`
          }
        }
        prompt += msg.content
        runner.sendMessage(prompt, msg.images)
      }
      if (runner.isReady) { sendIt(); return }
      // Queue until ready (max 30s)
      const start = Date.now()
      const tick = setInterval(() => {
        if (runner.isReady) { clearInterval(tick); sendIt() }
        else if (Date.now() - start > 30_000) { clearInterval(tick) }
      }, 250)
      return
    }
    if (msg.type === 'permission_response') {
      this.runner?.respondToPermission(msg.request_id, msg.approved)
      return
    }
    if (msg.type === 'question_response') {
      this.runner?.respondToQuestion(msg.request_id, msg.answer)
      return
    }
    if (msg.type === 'cancel') {
      this.runner?.cancel()
      return
    }
    if (msg.type === 'shutdown') {
      this.cb.onLog('info', `agent-bridge: shutdown requested (${msg.reason ?? 'no_reason'})`)
      void this.stop().then(() => this.cb.onExit({ code: 0, reason: 'hub_shutdown' }))
      return
    }
  }

  private ensureRunner(): CliRunner | null {
    if (this.runner) return this.runner
    const factory = this.opts.runnerFactory ?? ((repo, dangerous, orch) => new ClaudeRunner(repo, dangerous, orch))
    const runner = factory(this.opts.repoPath, this.opts.allowDangerousSkipPermissions, this.opts.orchestrator)
    this.runner = runner
    runner.start((e) => this.handleRunnerEvent(e))
    return runner
  }

  /** Phase-15 spike: lazily start the interactive PTY runner and bridge its
   *  raw output bytes to the hub as `term.data` frames. base64 over the
   *  existing /ws/agent JSON socket (see hub/src/ws/term-protocol.ts). */
  private ensurePtyRunner(): PtyLike | null {
    if (this.ptyRunner) return this.ptyRunner
    // PTY-cutover Phase A: gated factory → Rust ConPTY bridge in prod (Option C),
    // Node helper fallback when no Rust host. Default backend + cutover-gate
    // flag come from the supervisor config (env-overridable). Human-only.
    const pty = selectHumanPtyRunner({ isHuman: true }, getBackendSelectorConfig())
    this.ptyRunner = pty
    const sessionId = this.sessionId ?? undefined
    // Register with the supervisor-owned persistence coordinator so a dropped
    // client WS detaches (not kills) and reattach replays scrollback (R-PTY-27).
    if (sessionId) ptyPersistence.register(sessionId, pty)
    const emitTerm = (bytes: string) => {
      if (!this.sessionId) return
      this.sendToHub({
        type: 'term.data',
        session_id: this.sessionId,
        bytes: Buffer.from(bytes, 'binary').toString('base64'),
      })
    }
    pty.start({
      sessionId,
      cwd: this.opts.repoPath,
      cols: 100,
      rows: 30,
      // Operator-gated bypass — same ceiling as the stream-json runner. The PTY
      // appends `--dangerously-skip-permissions` (its SOLE permitted argv token).
      dangerouslySkipPermissions: this.opts.allowDangerousSkipPermissions,
      onData: (bytes) => {
        if (sessionId) { try { ptyPersistence.recordOutput(sessionId, bytes) } catch {} }
        emitTerm(bytes)
      },
      // Scrollback replay on (re)attach — Rust bridge only; sent as the same
      // base64 term.data shape so the browser replays it before live output.
      onScrollback: (bytes) => emitTerm(bytes),
      onExit: (code) => {
        this.cb.onLog('warn', `agent-bridge: pty runner exited code=${code}`)
        this.ptyRunner = null
        this.cb.onExit({ code, reason: 'pty_runner_exit' })
      },
    })
    if (!this.spawnReported) { this.spawnReported = true; this.cb.onSpawned({ pid: pty.pid ?? 0 }) }
    return pty
  }

  private handleRunnerEvent(e: RunnerEvent) {
    if (e.type === 'exited') {
      // Runner exited; the hub bridge stays up so reconnects pick up the same
      // session, but we surface so ProcessManager can finalize the run.
      this.cb.onLog('warn', `agent-bridge: runner exited code=${e.code}`)
      this.cb.onExit({ code: e.code, reason: 'runner_exit' })
      return
    }
    if (e.type === 'error') {
      this.cb.onLog('error', `agent-bridge: runner error: ${e.message}`)
      return
    }
    if (e.type === 'log') {
      // Forward as agent_log so the user sees in-UI runner diagnostics.
      if (this.sessionId) this.sendToHub({ type: 'agent_log', session_id: this.sessionId, message: e.message.slice(0, 1000) })
      this.cb.onLog('info', `runner: ${e.message}`)
      return
    }
    if (e.type === 'ready') {
      // Report pid once the runner is alive (best effort — pid is on the proc inside the runner).
      if (!this.spawnReported) {
        this.spawnReported = true
        this.cb.onSpawned({ pid: 0 })
      }
      return
    }
    if (e.type === 'result') {
      // P2: emit a usage_event so the hub can persist the per-turn token +
      // cost ledger. Only when we actually have token counts (an 'error'
      // result or an old CLI omits `usage` — skip those rather than record a
      // zero row). assistant_message was already emitted with the full text.
      if (this.sessionId && e.usage) {
        this.sendToHub({
          type: 'usage_event',
          session_id: this.sessionId,
          model: e.model ?? null,
          input_tokens: e.usage.input_tokens ?? 0,
          output_tokens: e.usage.output_tokens ?? 0,
          cache_creation_input_tokens: e.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: e.usage.cache_read_input_tokens ?? 0,
          cost_usd: e.cost ?? 0,
          cost_source: e.cost_from_sdk ? 'sdk' : 'estimated',
          ts: new Date().toISOString(),
        })
      }
      return
    }
    if (!this.sessionId) return
    // Pass-through event types share the session_id stamping shape.
    try { this.cb.onActivity?.() } catch {}
    const payload: any = { ...e, session_id: this.sessionId }
    this.sendToHub(payload)
  }

  private sendToHub(msg: AgentToHub | { type: string; [k: string]: unknown }) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(msg)) } catch {}
    }
  }
}
