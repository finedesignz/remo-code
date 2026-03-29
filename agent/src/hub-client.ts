import { hostname } from 'os'
import type { AgentToHub, HubToAgent } from './types'

type MessageHandler = (msg: HubToAgent) => void

export class HubClient {
  private ws: WebSocket | null = null
  private hubUrl: string
  private apiKey: string
  private projectDir: string
  private hostnameName: string
  private sessionId: string | null = null
  private onMessage: MessageHandler
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private authenticated = false

  constructor(
    hubUrl: string,
    apiKey: string,
    projectDir: string,
    onMessage: MessageHandler,
  ) {
    this.hubUrl = hubUrl
    this.apiKey = apiKey
    this.projectDir = projectDir.replace(/\\/g, '/')
    this.hostnameName = hostname()
    this.onMessage = onMessage
  }

  get sessionIdValue() { return this.sessionId }

  connect() {
    const wsUrl = this.hubUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/agent'
    console.log(`[hub-client] connecting to ${wsUrl}`)

    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      console.log('[hub-client] connected, authenticating...')
      this.send({
        type: 'auth',
        api_key: this.apiKey,
        project_dir: this.projectDir,
        hostname: this.hostnameName,
      })
    }

    this.ws.onmessage = (event) => {
      let msg: HubToAgent
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))
      } catch { return }

      if (msg.type === 'auth_ok') {
        this.authenticated = true
        this.sessionId = (msg as any).session_id
        console.log(`[hub-client] authenticated, session=${this.sessionId}`)
      }

      if (msg.type === 'auth_error') {
        console.error(`[hub-client] auth failed: ${msg.error}`)
        this.ws?.close()
        return
      }

      if (msg.type === 'ping') {
        this.send({ type: 'pong' })
        return
      }

      this.onMessage(msg)
    }

    this.ws.onclose = () => {
      console.log('[hub-client] disconnected, reconnecting in 5s...')
      this.authenticated = false
      this.reconnectTimer = setTimeout(() => this.connect(), 5000)
    }

    this.ws.onerror = (err) => {
      console.error('[hub-client] error:', err)
    }
  }

  send(msg: AgentToHub) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}
