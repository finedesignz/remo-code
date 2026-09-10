/**
 * Phase 20 — JSONL file tail helper shared by both adapters.
 *
 * Tails an append-only JSONL file: reads from a byte offset, splits complete
 * lines, hands each parsed JSON object to a callback, and advances the offset.
 * Uses `fs.watch` with a poll fallback (watch is unreliable on some Windows /
 * network filesystems — the poll backstop guarantees liveness).
 *
 * Read-only: this NEVER writes the transcript. Partial trailing lines (a record
 * the CLI is mid-write on) are held until the newline arrives.
 */

import { watch, type FSWatcher } from 'node:fs'
import { open as fsOpen, stat } from 'node:fs/promises'

const POLL_INTERVAL_MS = 500

export interface JsonlTail {
  close(): void
}

/**
 * Start tailing `path`. Existing content is replayed first (so an already-open
 * transcript surfaces its prior turns), then appends stream live. `onRecord`
 * receives each parsed JSON object; a line that fails JSON.parse is skipped
 * (logged by the adapter via `onParseError`).
 */
export function tailJsonl(
  path: string,
  onRecord: (record: unknown) => void,
  opts?: { onParseError?: (line: string, err: unknown) => void; fromStart?: boolean },
): JsonlTail {
  let offset = 0
  let carry = ''
  let closed = false
  let reading = false
  let watcher: FSWatcher | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const onParseError = opts?.onParseError

  async function pump(): Promise<void> {
    if (closed || reading) return
    reading = true
    try {
      let size: number
      try {
        size = (await stat(path)).size
      } catch {
        return // file not present (yet) — poll/watch will retry
      }
      if (size < offset) {
        // Truncated/rotated — reset and re-read from the top.
        offset = 0
        carry = ''
      }
      if (size === offset) return
      const fh = await fsOpen(path, 'r')
      try {
        const len = size - offset
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, offset)
        offset = size
        const chunk = carry + buf.toString('utf8')
        const lines = chunk.split('\n')
        carry = lines.pop() ?? '' // last element is a partial (or '' if ended on \n)
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            onRecord(JSON.parse(trimmed))
          } catch (err) {
            onParseError?.(trimmed, err)
          }
        }
      } finally {
        await fh.close()
      }
    } finally {
      reading = false
    }
  }

  // Initial replay (default: from start so prior turns are visible). The
  // watcher/poll must NOT be armed until this initial offset is settled —
  // otherwise, for a `fromStart:false` resumed transcript whose mtime is
  // recent precisely because the CLI just appended to it, a `fs.watch`
  // notification can fire and call `pump()` while `offset` is still its
  // initialized `0`, replaying every historical turn as new.
  async function initOffset(): Promise<void> {
    if (opts?.fromStart === false) {
      try {
        offset = (await stat(path)).size
      } catch {
        // file not present yet — leave offset at 0; poll/watch will pick it up naturally
      }
    } else {
      await pump()
    }
  }

  void initOffset().then(() => {
    if (closed) return
    try {
      watcher = watch(path, () => {
        void pump()
      })
      watcher.on('error', () => {
        // watch failed mid-flight — the poll fallback below keeps us live.
      })
    } catch {
      watcher = null
    }
    // Poll fallback always runs (cheap stat); covers watch gaps + initial absence.
    pollTimer = setInterval(() => {
      void pump()
    }, POLL_INTERVAL_MS)
  })

  return {
    close() {
      if (closed) return
      closed = true
      if (watcher) {
        try {
          watcher.close()
        } catch {
          /* ignore */
        }
        watcher = null
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    },
  }
}
