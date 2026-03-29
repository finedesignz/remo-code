import { hostname } from 'os'
import type { AgentToHub, HubToAgent } from './types'
import { printConnected, printDisconnected } from './local-ui'

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
    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
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
        printConnected(this.sessionId!)
      }

      if (msg.type === 'auth_error') {
        console.error('')
        console.error(`  Hub authentication failed: ${msg.error}`)
        console.error('')
        console.error(`  Hub URL: ${this.hubUrl}`)
        console.error('  Check that your API key is correct and not expired.')
        console.error('  Get a new key at https://app.remo-code.com/settings')
        console.error('')
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
      printDisconnected()
      this.authenticated = false
      this.reconnectTimer = setTimeout(() => this.connect(), 5000)
    }

    this.ws.onerror = (err) => {
      console.error(`[hub-client] Connection error to ${wsUrl}`)
      console.error('[hub-client] Check that the hub URL is reachable and your API key is valid.')
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
