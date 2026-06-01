/**
 * Phase 20 — per-session transcript-source manager.
 *
 * One `TranscriptSource` is opened per active (telegram-relevant) session and its
 * normalized `TranscriptEntry` stream is fanned to every registered consumer:
 *   - the Telegram outbound bridge (plan 02) — assistant_text + tool_use
 *   - the permission detector (plan 03) — permission_request / user_question
 *   - the PTY turn lock (plan 04) — turn_complete (lock release)
 *
 * A single tail, many consumers — so we don't open the same file N times. The
 * manager is the ONE place that resolves the open ctx (cli_kind + persisted
 * transcript identity) from the DB and selects the adapter; consumers never see a
 * backend-specific shape.
 *
 * Module-level Map (single-process hub). Redis is a future seam, same shape.
 */

import { selectAdapter } from './index.ts'
import type { TranscriptEntry, TranscriptOpenResult, TranscriptSource } from './types.ts'
import { getTranscriptOpenContext } from '../../db/dal.ts'

type Consumer = (entry: TranscriptEntry) => void

interface OpenSession {
  source: TranscriptSource
  consumers: Set<Consumer>
  result: TranscriptOpenResult
}

const sessions = new Map<string, OpenSession>()

/**
 * Resolve the open ctx for a session and return it, or null when the session row
 * is gone. Pluggable for tests via {@link _setContextResolverForTests}.
 */
let resolveCtx: typeof getTranscriptOpenContext = getTranscriptOpenContext

/**
 * Open (or reuse) the transcript source for `sessionId` and register `consumer`.
 * Returns an unsubscribe fn; the underlying source closes when the last consumer
 * unsubscribes. Idempotent per (session): a second subscribe reuses the open tail.
 *
 * Returns null when the session can't be resolved (no row). When the adapter
 * degrades to scrape-mode the consumer still attaches (it just receives only
 * assistant_text + turn_complete; never a permission).
 */
export async function subscribeToSessionTranscript(
  sessionId: string,
  consumer: Consumer,
): Promise<(() => void) | null> {
  let entry = sessions.get(sessionId)
  if (!entry) {
    const ctx = await resolveCtx(sessionId)
    if (!ctx) return null
    const source = selectAdapter(ctx.cliKind)
    const consumers = new Set<Consumer>()
    const fan = (e: TranscriptEntry) => {
      for (const c of consumers) {
        try {
          c(e)
        } catch (err: any) {
          console.warn(`[transcript-manager] consumer threw session=${sessionId}: ${err?.message ?? err}`)
        }
      }
    }
    const result = await source.open(
      {
        sessionId: ctx.sessionId,
        projectDir: ctx.projectDir,
        cliKind: ctx.cliKind,
        transcriptPath: ctx.transcriptPath,
        codexRolloutId: ctx.codexRolloutId,
      },
      fan,
    )
    entry = { source, consumers, result }
    sessions.set(sessionId, entry)
  }
  entry.consumers.add(consumer)

  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    const e = sessions.get(sessionId)
    if (!e) return
    e.consumers.delete(consumer)
    if (e.consumers.size === 0) {
      e.source.close()
      sessions.delete(sessionId)
    }
  }
}

/** The open mode for a session ('file' | 'scrape'), or null if not open. */
export function transcriptMode(sessionId: string): 'file' | 'scrape' | null {
  return sessions.get(sessionId)?.result.mode ?? null
}

/** Test-only — inject a context resolver (avoids a DB dependency in unit tests). */
export function _setContextResolverForTests(fn: typeof getTranscriptOpenContext | null): void {
  resolveCtx = fn ?? getTranscriptOpenContext
}

/** Test-only — close all open sources and clear the registry. */
export function _resetTranscriptManagerForTests(): void {
  for (const e of sessions.values()) {
    try {
      e.source.close()
    } catch {
      /* ignore */
    }
  }
  sessions.clear()
}
