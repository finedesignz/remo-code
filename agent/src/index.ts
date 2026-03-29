#!/usr/bin/env bun
import { loadConfig } from './config'
import { HubClient } from './hub-client'
import { ClaudeRunner, type RunnerEvent } from './claude-runner'
import type { HubToAgent } from './types'

const config = loadConfig()
console.log(`[remo-agent] project: ${config.projectDir}`)
console.log(`[remo-agent] hub: ${config.hubUrl}`)

const hub = new HubClient(config.hubUrl, config.apiKey, config.projectDir, handleMessage)
const runner = new ClaudeRunner(config.projectDir)

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
  runner.sendMessage(prompt)
}

// Connect to hub, then start Claude
hub.connect()

// Start Claude after a short delay to let hub auth complete
setTimeout(() => {
  console.log('[remo-agent] starting Claude process...')
  runner.start(handleRunnerEvent)
}, 2_000)

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[remo-agent] shutting down...')
  runner.stop()
  hub.close()
  process.exit(0)
})

console.log('[remo-agent] starting up...')
