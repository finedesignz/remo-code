#!/usr/bin/env bun
import { loadConfig } from './config'
import { HubClient } from './hub-client'
import { ClaudeRunner, type RunnerEvent } from './claude-runner'
import type { HubToAgent } from './types'
import * as ui from './local-ui'
import { spawnSync } from 'child_process'

const VERSION = '0.4.0'

// --- Pre-flight: check that claude CLI is available ---
const claudeCheck = spawnSync('claude', ['--version'], {
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 10_000,
})

if (claudeCheck.status !== 0 && !claudeCheck.stdout?.toString().trim()) {
  ui.printError('Claude Code CLI not found.')
  console.error('')
  console.error('  The remo-code-agent requires the Claude Code CLI to be installed')
  console.error('  and available in your PATH.')
  console.error('')
  console.error('  Install it from: https://claude.ai/code')
  console.error('')
  process.exit(1)
}

// --- Load config ---
const config = loadConfig()

// --- Startup banner ---
ui.printBanner(VERSION, config.projectDir, config.hubUrl, config.resume)

const hub = new HubClient(config.hubUrl, config.apiKey, config.projectDir, handleMessage, VERSION)
const runner = new ClaudeRunner(config.projectDir, config.localOutput, config.resume)

function sendLog(message: string) {
  const sessionId = hub.sessionIdValue
  if (!sessionId) return
  hub.send({ type: 'agent_log', session_id: sessionId, message })
}

function handleRunnerEvent(event: RunnerEvent) {
  const sessionId = hub.sessionIdValue
  if (!sessionId) return
  if (event.type === 'result' || event.type === 'ready') return // internal, don't relay
  if (event.type === 'log') {
    sendLog(event.message)
    return
  }
  hub.send({ ...event, session_id: sessionId } as any)
}

let runnerStarted = false
function startRunnerOnce() {
  if (runnerStarted) return
  runnerStarted = true
  console.log('[remo-agent] Starting Claude process...')
  runner.start(handleRunnerEvent)
}

function handleMessage(msg: HubToAgent) {
  if (msg.type === 'auth_ok') {
    sendLog(`Remo Code Agent v${VERSION} connected — ${config.projectDir}`)
    if (msg.system_prompt) {
      runner.setSystemPrompt(msg.system_prompt)
      sendLog(`Custom system prompt applied (${msg.system_prompt.length} chars)`)
    }
    startRunnerOnce()
  }
  if (msg.type === 'user_message') {
    if (!runner.isReady) {
      console.log('[remo-agent] Claude not ready yet, queuing...')
      // Wait for ready, then send
      const check = setInterval(() => {
        if (runner.isReady) {
          clearInterval(check)
          sendUserMessage(msg)
        }
      }, 500)
      setTimeout(() => clearInterval(check), 30_000) // give up after 30s
      return
    }
    sendUserMessage(msg)
  }
  if (msg.type === 'permission_response') {
    console.log(`[remo-agent] permission response: ${msg.approved ? 'approved' : 'denied'} (${msg.request_id})`)
    runner.respondToPermission(msg.request_id, msg.approved)
  }
  if (msg.type === 'question_response') {
    console.log(`[remo-agent] question answer received (${msg.request_id})`)
    runner.respondToQuestion(msg.request_id, msg.answer)
  }
  if (msg.type === 'cancel') {
    runner.cancel()
  }
  if (msg.type === 'shutdown') {
    const reason = msg.reason ?? 'hub_requested'
    console.log(`[remo-agent] Shutdown requested by hub (${reason}). Stopping Claude...`)
    runner.stopGracefully().finally(() => {
      try { hub.close() } catch {}
      process.exit(0)
    })
  }
}

function sendUserMessage(msg: Extract<HubToAgent, { type: 'user_message' }>) {
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

// Connect to hub — Claude is started after auth_ok so the system prompt
// (if any) is applied on the first spawn. Fallback timer in case the hub
// connection takes longer than expected.
hub.connect()
setTimeout(() => {
  if (!runnerStarted) {
    console.log('[remo-agent] auth_ok not received yet — starting Claude without server-side system prompt')
    startRunnerOnce()
  }
}, 5_000)

// If --initial-prompt was given, send it once both hub auth + Claude are ready
if (config.initialPrompt) {
  const initial = config.initialPrompt
  const trySend = () => {
    if (hub.sessionIdValue && runner.isReady) {
      console.log('[remo-agent] Sending initial prompt...')
      runner.sendMessage(initial)
      return true
    }
    return false
  }
  const check = setInterval(() => {
    if (trySend()) clearInterval(check)
  }, 500)
  setTimeout(() => clearInterval(check), 60_000)
}


// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[remo-agent] Shutting down...')
  runner.stop()
  hub.close()
  process.exit(0)
})
