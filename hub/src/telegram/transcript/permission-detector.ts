/**
 * Phase 20 plan 03 — fail-closed pending-permission / user_question detector.
 *
 * With stream-json gone, permission prompts exist only as transcript entries.
 * This module is the SECURITY BOUNDARY: it decides whether a transcript entry is
 * a discrete, enumerable, keystroke-mappable choice that may be surfaced to
 * Telegram for a tap-to-approve.
 *
 * FAIL-CLOSED (T-20-06, CRITICAL — defense in depth):
 *   1. Only a `permission_request` / `user_question` TranscriptEntry that carries
 *      {sessionId, requestId, a non-empty enumerated options[]} is accepted.
 *   2. NO default / implicit choice. NO "approve on timeout". NO "approve on
 *      parse-uncertain". Ambiguous / partial / unmapped ⇒ return null (emit
 *      nothing — no Telegram prompt, no keystroke).
 *   3. The adapters already guarantee scrape-mode emits NO permission_request
 *      (you cannot fail-closed-parse a permission out of raw bytes), so a
 *      scrape-mode entry never reaches a permission shape here.
 *
 * The detector is a PURE function over TranscriptEntry → DetectedPending | null.
 * It does not surface, key, or inject — that is the bridge + approvals registry +
 * keystroke map (tasks 2/3). The output mirrors the deleted PermissionPendingEvent
 * fields so the `(sessionId, requestId)` keying is reused verbatim.
 */

import type { CliKind, TranscriptEntry, TranscriptOption } from './types.ts'

export interface DetectedPending {
  sessionId: string
  requestId: string
  /** Tool name (permission) or the question text (user_question). */
  toolName: string
  toolInput?: unknown
  /** The enumerated, keystroke-mappable choices. Never empty. */
  options: TranscriptOption[]
  /** Discriminates the keystroke mapping the injector must apply (task 3). */
  shape: 'permission' | 'question'
}

let skipped = 0

/** Diagnostic counter — how many entries were skipped as ambiguous/unmapped. */
export function detectorSkipCount(): number {
  return skipped
}

/** Test-only — reset the skip counter. */
export function _resetDetectorSkipCountForTests(): void {
  skipped = 0
}

/**
 * Detect a pending choice from a transcript entry. Returns a normalized pending
 * ONLY for a clean, enumerated permission_request / user_question; everything
 * else (including every non-prompt entry kind) ⇒ null + skip-count bump for the
 * prompt kinds that fail validation (so a malformed permission is observable
 * without being surfaced).
 */
export function detectPending(entry: TranscriptEntry): DetectedPending | null {
  switch (entry.kind) {
    case 'permission_request': {
      if (!isClean(entry.sessionId, entry.requestId, entry.options)) {
        skipped++
        return null
      }
      if (!entry.toolName) {
        skipped++
        return null
      }
      return {
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        toolName: entry.toolName,
        toolInput: entry.toolInput,
        options: entry.options,
        shape: 'permission',
      }
    }
    case 'user_question': {
      if (!isClean(entry.sessionId, entry.requestId, entry.options)) {
        skipped++
        return null
      }
      if (!entry.questionText) {
        skipped++
        return null
      }
      return {
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        toolName: entry.questionText,
        options: entry.options,
        shape: 'question',
      }
    }
    // assistant_text / tool_use / turn_complete are never permissions.
    default:
      return null
  }
}

/** A clean pending requires a sessionId, a non-empty requestId, and at least one
 *  enumerated option each with a stable id + label. Anything missing ⇒ false
 *  (fail closed). */
function isClean(sessionId: string, requestId: string, options: TranscriptOption[]): boolean {
  if (!sessionId || !requestId) return false
  if (!Array.isArray(options) || options.length === 0) return false
  for (const o of options) {
    if (!o || typeof o.id !== 'string' || o.id.length === 0) return false
    if (typeof o.label !== 'string' || o.label.length === 0) return false
  }
  return true
}

/** Re-export for the keystroke map (task 3) — the cliKind travels on the open
 *  ctx, not the entry, so the injector resolves it separately. */
export type { CliKind }
