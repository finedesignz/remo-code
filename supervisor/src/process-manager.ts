import type { Subprocess } from 'bun'

export type ProcState = 'idle' | 'starting' | 'running' | 'stopping' | 'crashed' | 'stopped'

export interface RunSpec {
  runId: string
  repoPath: string
  branch: string | null
  initialPrompt: string | null
  apiKey: string
  hubUrl: string
}

export interface ProcessManagerCallbacks {
  onStateChange: (state: ProcState, info: { runId?: string; repoPath?: string; pid?: number; restartCount?: number; lastExit?: { code: number | null; reason: string; stderrTail?: string } }) => void
  onLog: (level: 'info' | 'warn' | 'error', message: string, runId?: string) => void
}

const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000]
const CIRCUIT_WINDOW_MS = 10 * 60_000
const CIRCUIT_THRESHOLD = 5

export class ProcessManager {
  private state: ProcState = 'idle'
  private proc: Subprocess | null = null
  private currentRun: RunSpec | null = null
  private restartCount = 0
  private recentCrashes: number[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private userStop = false
  private cb: ProcessManagerCallbacks
  private stderrTail: string[] = []

  constructor(cb: ProcessManagerCallbacks) {
    this.cb = cb
  }

  get currentState() { return this.state }
  get currentRunId() { return this.currentRun?.runId ?? null }
  get currentRepoPath() { return this.currentRun?.repoPath ?? null }

  async start(spec: RunSpec) {
    if (this.state !== 'idle') {
      this.cb.onLog('warn', `Refusing start: current state=${this.state}`, spec.runId)
      return
    }
    this.currentRun = spec
    this.restartCount = 0
    this.recentCrashes = []
    this.userStop = false
    this.spawnInner()
  }

  private spawnInner() {
    if (!this.currentRun) return
    const spec = this.currentRun

    this.setState('starting', { runId: spec.runId, repoPath: spec.repoPath, restartCount: this.restartCount })

    // Spawn the standard remo-code-agent. The agent connects to the hub itself,
    // registers a session by project_dir, parses claude's stream-json, and relays
    // activity events. The supervisor only owns process lifecycle (start/stop/restart).
    this.stderrTail = []
    const cmd = [
      'npx', '-y', 'remo-code-agent',
      '--api-key', spec.apiKey,
      '--hub-url', spec.hubUrl,
      '--project-dir', spec.repoPath,
    ]
    if (spec.initialPrompt) {
      cmd.push('--initial-prompt', spec.initialPrompt)
    }
    const env = { ...process.env }
    delete (env as any).ANTHROPIC_API_KEY

    try {
      this.proc = Bun.spawn(cmd, {
        cwd: spec.repoPath,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      })
    } catch (err: any) {
      this.cb.onLog('error', `failed to spawn agent: ${err.message}`, spec.runId)
      this.setState('crashed', { runId: spec.runId, repoPath: spec.repoPath, lastExit: { code: null, reason: `spawn_error: ${err.message}` } })
      this.scheduleRestart(null, 'spawn_error')
      return
    }

    const pid = this.proc.pid
    this.cb.onLog('info', `agent spawned pid=${pid} in ${spec.repoPath}`, spec.runId)
    this.setState('running', { runId: spec.runId, repoPath: spec.repoPath, pid, restartCount: this.restartCount })

    this.consumeStdoutAsLogs()
    this.consumeStderr()

    this.proc.exited.then((code) => {
      const reason = this.userStop ? 'user' : code === 0 ? 'clean' : 'crash'
      const tail = this.stderrTail.slice(-40).join('\n')
      this.cb.onLog(reason === 'crash' ? 'error' : 'info', `claude exited code=${code} reason=${reason}`, spec.runId)

      if (this.userStop) {
        this.setState('idle', { runId: spec.runId, lastExit: { code: code ?? null, reason, stderrTail: tail } })
        this.currentRun = null
        return
      }

      if (reason === 'clean') {
        this.setState('idle', { runId: spec.runId, lastExit: { code: code ?? null, reason, stderrTail: tail } })
        this.currentRun = null
        return
      }

      // crash
      this.recentCrashes.push(Date.now())
      this.recentCrashes = this.recentCrashes.filter((t) => Date.now() - t < CIRCUIT_WINDOW_MS)
      if (this.recentCrashes.length >= CIRCUIT_THRESHOLD) {
        this.cb.onLog('error', `circuit breaker open: ${this.recentCrashes.length} crashes in ${CIRCUIT_WINDOW_MS / 60_000}min — stopping`, spec.runId)
        this.setState('stopped', { runId: spec.runId, lastExit: { code: code ?? null, reason: 'circuit_open', stderrTail: tail } })
        this.currentRun = null
        return
      }
      this.scheduleRestart(code ?? null, 'crash', tail)
    })
  }

  private scheduleRestart(exitCode: number | null, reason: string, stderrTail = '') {
    if (!this.currentRun) return
    const delay = BACKOFF_SCHEDULE[Math.min(this.restartCount, BACKOFF_SCHEDULE.length - 1)]
    this.restartCount++
    this.cb.onLog('warn', `restarting in ${delay}ms (attempt ${this.restartCount})`, this.currentRun.runId)
    this.setState('crashed', { runId: this.currentRun.runId, lastExit: { code: exitCode, reason, stderrTail } })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.currentRun) return
      this.spawnInner()
    }, delay)
  }

  async stop(reason: string) {
    if (this.state === 'idle') return
    this.userStop = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    this.setState('stopping', { runId: this.currentRun?.runId })
    if (this.proc) {
      try { this.proc.kill('SIGINT') } catch {}
      // SIGKILL after 10s
      setTimeout(() => {
        if (this.proc) {
          try { this.proc.kill('SIGKILL') } catch {}
        }
      }, 10_000)
    }
  }

  private setState(state: ProcState, info: any = {}) {
    this.state = state
    this.cb.onStateChange(state, { restartCount: this.restartCount, ...info })
  }

  private async consumeStdoutAsLogs() {
    if (!this.proc?.stdout) return
    try {
      const reader = this.proc.stdout.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (line.trim()) {
            this.cb.onLog('info', `[agent] ${line.slice(0, 500)}`, this.currentRun?.runId)
          }
        }
      }
    } catch {}
  }

  private async consumeStderr() {
    if (!this.proc?.stderr) return
    try {
      const reader = this.proc.stderr.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (line.trim()) {
            this.stderrTail.push(line)
            if (this.stderrTail.length > 200) this.stderrTail.shift()
          }
        }
      }
    } catch {}
  }
}
