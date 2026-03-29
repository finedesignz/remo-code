#!/usr/bin/env bun
import { loadConfig } from './config'
import { HubClient } from './hub-client'
import { ClaudeRunner } from './claude-runner'
import type { HubToAgent } from './types'

const config = loadConfig()
console.log(`[remo-agent] project: ${config.projectDir}`)
console.log(`[remo-agent] hub: ${config.hubUrl}`)

const runner = new ClaudeRunner(config.projectDir)

function handleMessage(msg: HubToAgent) {
  if (msg.type === 'user_message') {
    handleUserMessage(msg)
  }
  if (msg.type === 'cancel') {
    runner.cancel()
  }
}

const hub = new HubClient(config.hubUrl, config.apiKey, config.projectDir, handleMessage)
hub.connect()

async function handleUserMessage(msg: Extract<HubToAgent, { type: 'user_message' }>) {
  const sessionId = hub.sessionIdValue
  if (!sessionId) return

  // Build the prompt: prepend file attachments, append user message
  let prompt = ''
  if (msg.attachments?.length) {
    for (const att of msg.attachments) {
      prompt += `[Attached file: ${att.filename}]\n${att.content}\n\n`
    }
  }
  prompt += msg.content

  // TODO: handle images (save to temp file, reference in prompt) — Phase 2

  try {
    for await (const event of runner.run(prompt)) {
      if (event.type === 'result') continue // internal, don't relay
      hub.send({ ...event, session_id: sessionId } as any)
    }
  } catch (err: any) {
    console.error('[remo-agent] runner error:', err.message)
    hub.send({ type: 'status', session_id: sessionId, state: 'idle' })
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[remo-agent] shutting down...')
  runner.cancel()
  hub.close()
  process.exit(0)
})

console.log('[remo-agent] ready, waiting for messages...')
