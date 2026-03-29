#!/usr/bin/env bun
import { loadConfig } from './config'
import { HubClient } from './hub-client'
import { ClaudeRunner, type RunnerEvent } from './claude-runner'
import type { HubToAgent } from './types'
import { spawnSync } from 'child_process'

const VERSION = '0.1.0'

// --- Pre-flight: check that claude CLI is available ---
const claudeCheck = spawnSync('claude', ['--version'], {
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 5_000,
  shell: true,
})

if (claudeCheck.status !== 0 && !claudeCheck.stdout?.toString().trim()) {
  console.error('')
  console.error('  Claude Code CLI not found.')
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
console.log('')
console.log(`  Remo Code Agent v${VERSION}`)
console.log(`  Project: ${config.projectDir}`)
console.log(`  Hub:     ${config.hubUrl}`)
console.log(`  Output:  ${config.localOutput ? 'terminal + web' : 'web only'}`)
console.log(`  Connecting...`)
console.log('')

const hub = new HubClient(config.hubUrl, config.apiKey, config.projectDir, handleMessage)
const runner = new ClaudeRunner(config.projectDir, config.localOutput)

function handleRunnerEvent(event: RunnerEvent) {
  const sessionId = hub.sessionIdValue
  if (!sessionId) return
  if (event.type === 'result' || event.type === 'ready') return // internal, don't relay
  hub.send({ ...event, session_id: sessionId } as any)
}

function handleMessage(msg: HubToAgent) {
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
  if (msg.type === 'cancel') {
    runner.cancel()
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
  if (config.localOutput) {
    process.stdout.write(`\x1b[32m> ${msg.content}\x1b[0m\n\n`)
  }
  runner.sendMessage(prompt)
}

// Connect to hub, then start Claude
hub.connect()

// Start Claude after a short delay to let hub auth complete
setTimeout(() => {
  console.log('[remo-agent] Starting Claude process...')
  runner.start(handleRunnerEvent)
}, 2_000)

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[remo-agent] Shutting down...')
  runner.stop()
  hub.close()
  process.exit(0)
})
