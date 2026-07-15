/**
 * DEV/TEST ONLY harness page for TerminalSurface — mounts the real component with
 * a stub WS transport so a real Chromium (Playwright) can drive real touch/mouse
 * gestures against the genuine gesture handler and assert xterm textarea focus.
 * Not part of the shipped SPA (separate Vite entry, served only by the dev server).
 */
import { createRoot } from 'react-dom/client'
import { TerminalSurface } from './components/TerminalSurface'

// Stub transport: swallow outbound frames, never deliver inbound. The gesture
// handler + xterm render exactly as in prod; only the network is stubbed.
const send = () => {}
const subscribe = (_h: (msg: any) => void) => () => {}

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100%' }}>
    <TerminalSurface sessionId="harness" send={send} subscribe={subscribe} />
  </div>,
)
