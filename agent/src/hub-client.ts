import { hostname, platform, release, arch, cpus, totalmem } from 'os'
import type { AgentToHub, HubToAgent } from './types'
import { printConnected, printDisconnected } from './local-ui'

type MessageHandler = (msg: HubToAgent) => void

export interface AgentInfo {
  hostname: string
  platform: string
  os_release: string
  arch: string
  cpu_model?: string
  cpu_cores: number
  total_mem_bytes: number
  node_version?: string
  bun_version?: string
  agent_version?: string
}

function collectAgentInfo(agentVersion?: string): AgentInfo {
  const cpuList = cpus()
  return {
    hostname: hostname(),
    platform: platform(),
    os_release: release(),
    arch: arch(),
    cpu_model: cpuList[0]?.model,
    cpu_cores: cpuList.length,
    total_mem_bytes: totalmem(),
    node_version: process.versions.node,
    bun_version: (process.versions as any).bun,
    agent_version: agentVersion,
  }
}

export class HubClient {
  private ws: WebSocket | null = null
  private hubUrl: string
  private apiKey: string
  private projectDir: string
  private hostnameName: string
  private agentInfo: AgentInfo
  private sessionId: string | null = null
  private onMessage: MessageHandler
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private authenticated = false
  private stopped = false

  constructor(
    hubUrl: string,
    apiKey: string,
    projectDir: string,
    onMessage: MessageHandler,
    agentVersion?: string,
  ) {
    this.hubUrl = hubUrl
    this.apiKey = apiKey
    this.projectDir = projectDir.replace(/\\/g, '/')
    this.hostnameName = hostname()
    this.agentInfo = collectAgentInfo(agentVersion)
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
        agent_info: this.agentInfo,
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
        if (msg.error === 'session_disconnected') {
          console.error('')
          console.error('  Session was disconnected from the web UI.')
          console.error('  Stopping agent. Run claude-remote again to start a fresh session.')
          console.error('')
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
          this.stopped = true
          try { this.ws?.close() } catch {}
          process.exit(0)
        }
        console.error('')
        console.error(`  Hub authentication failed: ${msg.error}`)
        console.error('')
        console.error(`  Hub URL: ${this.hubUrl}`)
        console.error('  Check that your API key is correct and not expired.')
        console.error('  Get a new key at https://app.remo-code.com/settings')
        console.error('')
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        this.stopped = true
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
      if (this.stopped) return
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
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}
