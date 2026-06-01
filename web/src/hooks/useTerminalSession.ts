/**
 * useTerminalSession.ts — Phase-16 (R-PTY-09) term.* WS lifecycle hook.
 *
 * Owns the raw-terminal WS for ONE pty-interactive session and wires it to an
 * xterm.js Terminal:
 *   - initial attach → live term.data,
 *   - reconnect → term.reattach → scrollback replay → resume live,
 *   - resize → term.resize (cols/rows propagate to the PTY),
 *   - teardown on unmount / session switch (clears the xterm buffer BEFORE any
 *     replay so a prior session's bytes never bleed into the new one — T-16-10).
 *
 * Keyed entirely by session_id. The xterm Terminal + FitAddon are owned by the
 * surface component and passed in; this hook only manages the WS + writes bytes
 * into the terminal.
 */
import { useEffect, useRef } from 'react'
import { openTermWs, type TermWs } from '../lib/term-ws'

export interface TerminalLike {
  write(data: string): void
  clear(): void
  onData(cb: (data: string) => void): { dispose(): void }
}

export interface UseTerminalSessionOpts {
  sessionId: string
  token: string | null
  /** The xterm Terminal (or a compatible shim in tests). Null until mounted. */
  terminal: TerminalLike | null
  /** Current cols/rows (FitAddon-computed); changes trigger a term.resize. */
  cols: number
  rows: number
  /** Injectable WS factory (tests). */
  wsFactory?: (url: string) => WebSocket
}

export function useTerminalSession(opts: UseTerminalSessionOpts) {
  const { sessionId, token, terminal, cols, rows, wsFactory } = opts
  const wsRef = useRef<TermWs | null>(null)
  const inputDisposeRef = useRef<{ dispose(): void } | null>(null)

  // (Re)open the WS whenever the session or the terminal instance changes.
  useEffect(() => {
    if (!terminal) return
    // SESSION SWITCH / mount: clear any prior buffer BEFORE attaching so the new
    // session never renders the previous one's scrollback (T-16-10).
    terminal.clear()

    const ws = openTermWs(
      sessionId,
      token,
      {
        onScrollback: (bytes) => {
          // Replay buffered scrollback, then live term.data resumes.
          terminal.clear()
          terminal.write(bytes)
        },
        onData: (bytes) => terminal.write(bytes),
        onClose: () => {
          // The hub keeps the PTY alive on disconnect (detach); the next mount /
          // reconnect will term.reattach and replay. Nothing to do here beyond
          // letting the effect cleanup/re-run handle reconnection.
        },
      },
      wsFactory,
    )
    wsRef.current = ws

    // Forward keystrokes from xterm → PTY.
    inputDisposeRef.current = terminal.onData((data) => ws.sendInput(data))

    return () => {
      inputDisposeRef.current?.dispose()
      inputDisposeRef.current = null
      ws.close()
      wsRef.current = null
    }
  }, [sessionId, terminal, token, wsFactory])

  // Propagate resize (cols/rows) to the PTY.
  useEffect(() => {
    if (!wsRef.current) return
    if (cols > 0 && rows > 0) wsRef.current.resize(cols, rows)
  }, [cols, rows])

  return {
    sendInput: (data: string) => wsRef.current?.sendInput(data),
    resize: (c: number, r: number) => wsRef.current?.resize(c, r),
    reattach: () => wsRef.current?.reattach(),
  }
}
