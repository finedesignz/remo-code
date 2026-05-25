#!/usr/bin/env bun
import { loadConfig } from './config'
import { HubClient } from './hub-client'
import { ClaudeRunner } from './claude-runner'
import { CodexRunner } from './codex-runner'
import type { CliRunner, RunnerEvent } from './cli-runner'
import type { HubToAgent } from './types'
import * as ui from './local-ui'
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const VERSION = '0.4.1'

// --- Load config ---
const config = loadConfig()

// --- Startup banner ---
ui.printBanner(VERSION, config.projectDir, config.hubUrl, config.resume)

const hub = new HubClient(config.hubUrl, config.apiKey, config.projectDir, handleMessage, VERSION)

// Per-session runner registry. Project session + 0..N rootless sessions coexist.
type SessionInfo = { cliKind: 'claude' | 'codex'; isRootless: boolean; workingDir: string }
const sessionMeta = new Map<string, SessionInfo>()
const runners = new Map<string, CliRunner>()
const pendingSystemPrompts = new Map<string, string>()
const preflightDone = new Set<'claude' | 'codex'>()
let primarySessionId: string | null = null

function preflight(cliKind: 'claude' | 'codex') {
  if (preflightDone.has(cliKind)) return
  preflightDone.add(cliKind)
  const check = spawnSync(cliKind, ['--version'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  if (check.status !== 0 && !check.stdout?.toString().trim()) {
    if (cliKind === 'claude') {
      ui.printError('Claude Code CLI not found.')
      console.error('')
      console.error('  Install it from: https://claude.ai/code')
    } else {
      ui.printError('Codex CLI not found.')
      console.error('')
      console.error('  Install it with: npm i -g @openai/codex')
      console.error('  Then run:        codex login   (or set OPENAI_API_KEY)')
    }
    console.error('')
    process.exit(1)
  }
}

function sendLog(message: string, sessionId?: string) {
  const sid = sessionId ?? primarySessionId ?? hub.sessionIdValue
  if (!sid) return
  hub.send({ type: 'agent_log', session_id: sid, message })
}

function makeHandler(sessionId: string) {
  return (event: RunnerEvent) => {
    if (event.type === 'result' || event.type === 'ready') return
    if (event.type === 'log') {
      sendLog(event.message, sessionId)
      return
    }
    hub.send({ ...event, session_id: sessionId } as any)
  }
}

function getOrStartRunner(sessionId: string): CliRunner | null {
  const existing = runners.get(sessionId)
  if (existing) return existing

  const meta = sessionMeta.get(sessionId)
  if (!meta) {
    console.error(`[remo-agent] unknown session ${sessionId}; dropping`)
    return null
  }

  preflight(meta.cliKind)
  try { mkdirSync(meta.workingDir, { recursive: true }) } catch {}

  let runner: CliRunner
  if (meta.cliKind === 'codex') {
    runner = new CodexRunner(meta.workingDir, config.localOutput)
  } else {
    runner = new ClaudeRunner(
      meta.workingDir,
      config.localOutput,
      meta.isRootless ? undefined : config.resume,
    )
  }
  const sysPrompt = pendingSystemPrompts.get(sessionId)
  if (sysPrompt) runner.setSystemPrompt(sysPrompt)
  runner.start(makeHandler(sessionId))
  runners.set(sessionId, runner)
  return runner
}

function registerSession(sessionId: string, cliKind: 'claude' | 'codex', isRootless: boolean) {
  if (sessionMeta.has(sessionId)) return
  const workingDir = isRootless
    ? join(homedir(), '.remo-code', 'rootless', cliKind)
    : config.projectDir
  sessionMeta.set(sessionId, { cliKind, isRootless, workingDir })
}

let projectStartScheduled = false
function startProjectRunnerOnce() {
  if (projectStartScheduled) return
  projectStartScheduled = true
  if (primarySessionId) {
    console.log('[remo-agent] Starting primary runner...')
    getOrStartRunner(primarySessionId)
  }
}

function handleMessage(msg: HubToAgent) {
  if (msg.type === 'auth_ok') {
    const cliKind = msg.cli_kind ?? 'claude'
    primarySessionId = msg.session_id
    registerSession(msg.session_id, cliKind, false)

    // Register rootless sessions (lazy-start; only spawn on first user_message)
    if (msg.rootless_session_ids) {
      for (const kind of ['claude', 'codex'] as const) {
        const sid = msg.rootless_session_ids[kind]
        if (sid) registerSession(sid, kind, true)
      }
    }

    sendLog(`Remo Code Agent v${VERSION} connected — ${config.projectDir} (cli=${cliKind})`)

    if (msg.system_prompt) {
      pendingSystemPrompts.set(msg.session_id, msg.system_prompt)
      sendLog(`Custom system prompt applied (${msg.system_prompt.length} chars)`)
    }

    // Pre-flight only the CLIs we'll actually host
    const cliKinds = new Set<'claude' | 'codex'>([cliKind])
    if (msg.rootless_session_ids) {
      for (const k of ['claude', 'codex'] as const) {
        if (msg.rootless_session_ids[k]) cliKinds.add(k)
      }
    }
    for (const k of cliKinds) preflight(k)

    startProjectRunnerOnce()
    return
  }

  if (msg.type === 'user_message') {
    const runner = getOrStartRunner(msg.session_id)
    if (!runner) return
    if (!runner.isReady) {
      console.log('[remo-agent] runner not ready yet, queuing...')
      const check = setInterval(() => {
        if (runner.isReady) {
          clearInterval(check)
          sendUserMessage(runner, msg)
        }
      }, 500)
      setTimeout(() => clearInterval(check), 30_000)
      return
    }
    sendUserMessage(runner, msg)
    return
  }

  if (msg.type === 'permission_response') {
    runners.get(msg.session_id)?.respondToPermission(msg.request_id, msg.approved)
    return
  }
  if (msg.type === 'question_response') {
    runners.get(msg.session_id)?.respondToQuestion(msg.request_id, msg.answer)
    return
  }
  if (msg.type === 'cancel') {
    runners.get(msg.session_id)?.cancel()
    return
  }
  if (msg.type === 'shutdown') {
    const reason = msg.reason ?? 'hub_requested'
    console.log(`[remo-agent] Shutdown requested by hub (${reason}). Stopping runners...`)
    Promise.all([...runners.values()].map((r) => r.stopGracefully())).finally(() => {
      try { hub.close() } catch {}
      process.exit(0)
    })
  }
}

function sendUserMessage(runner: CliRunner, msg: Extract<HubToAgent, { type: 'user_message' }>) {
  let prompt = ''
  if (msg.attachments?.length) {
    for (const att of msg.attachments) {
      prompt += `[Attached file: ${att.filename}]\n${att.content}\n\n`
    }
  }
  prompt += msg.content
  if (config.localOutput) ui.printUserMessage(msg.content)
  runner.sendMessage(prompt, msg.images)
}

// Connect to hub — runners are started after auth_ok so system prompt + cli_kind
// are honored on the first spawn. Fallback timer in case auth_ok never arrives.
hub.connect()
setTimeout(() => {
  if (!projectStartScheduled && primarySessionId) {
    console.log('[remo-agent] auth_ok not received — starting primary runner without server prompt')
    startProjectRunnerOnce()
  } else if (!projectStartScheduled) {
    // No session yet from hub — assume legacy Claude + start with project_dir as primary.
    console.log('[remo-agent] auth_ok delayed — starting legacy Claude runner against project_dir')
    const legacyId = 'legacy:local'
    primarySessionId = legacyId
    registerSession(legacyId, 'claude', false)
    startProjectRunnerOnce()
  }
}, 5_000)

// If --initial-prompt was given, send it once both hub auth + primary runner are ready
if (config.initialPrompt) {
  const initial = config.initialPrompt
  const trySend = () => {
    if (!primarySessionId) return false
    const r = runners.get(primarySessionId)
    if (hub.sessionIdValue && r?.isReady) {
      console.log('[remo-agent] Sending initial prompt...')
      r.sendMessage(initial)
      return true
    }
    return false
  }
  const check = setInterval(() => { if (trySend()) clearInterval(check) }, 500)
  setTimeout(() => clearInterval(check), 60_000)
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[remo-agent] Shutting down...')
  for (const r of runners.values()) {
    try { r.stop() } catch {}
  }
  hub.close()
  process.exit(0)
})
