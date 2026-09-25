// Cloud-host support: hub WebSockets honour HTTPS_PROXY / NO_PROXY
// (docs/cloud-session-supervisor.md). No proxy env ⇒ direct, unchanged.
import { describe, it, expect } from 'bun:test'
import { wsProxyFor, isNoProxyHost } from '../src/ws-proxy'

const URL_WSS = 'wss://app.remo-code.com/ws/agent'

describe('wsProxyFor', () => {
  it('is direct when no proxy env is set (tray-app hosts unchanged)', () => {
    expect(wsProxyFor(URL_WSS, {})).toBeUndefined()
  })
  it('uses HTTPS_PROXY (or lowercase) for wss://', () => {
    expect(wsProxyFor(URL_WSS, { HTTPS_PROXY: 'http://127.0.0.1:1' })).toBe('http://127.0.0.1:1')
    expect(wsProxyFor(URL_WSS, { https_proxy: 'http://127.0.0.1:2' })).toBe('http://127.0.0.1:2')
  })
  it('uses HTTP_PROXY, not HTTPS_PROXY, for ws://', () => {
    expect(wsProxyFor('ws://localhost:3040/ws/agent', { HTTPS_PROXY: 'http://p:1' })).toBeUndefined()
    expect(wsProxyFor('ws://h:3040/ws/agent', { HTTP_PROXY: 'http://p:2' })).toBe('http://p:2')
  })
  it('honours NO_PROXY', () => {
    const env = { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'localhost,.remo-code.com' }
    expect(wsProxyFor(URL_WSS, env)).toBeUndefined()
    expect(wsProxyFor('wss://other.example/ws', env)).toBe('http://p:1')
  })
  it('ignores an unparseable url', () => {
    expect(wsProxyFor('not a url', { HTTPS_PROXY: 'http://p:1' })).toBeUndefined()
  })
})

describe('isNoProxyHost', () => {
  it('matches *, exact, suffix and dotted entries; ignores ports', () => {
    expect(isNoProxyHost('a.b.com', '*')).toBe(true)
    expect(isNoProxyHost('b.com', 'b.com')).toBe(true)
    expect(isNoProxyHost('a.b.com', 'b.com')).toBe(true)
    expect(isNoProxyHost('ab.com', 'b.com')).toBe(false)
    expect(isNoProxyHost('a.b.com', '.b.com')).toBe(true)
    expect(isNoProxyHost('a.b.com', '*.b.com')).toBe(true)
    expect(isNoProxyHost('b.com', 'b.com:443')).toBe(true)
    expect(isNoProxyHost('c.com', 'b.com, ,d.com')).toBe(false)
  })
})
