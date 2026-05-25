import { existsSync, mkdirSync, renameSync, statSync, appendFileSync } from 'fs'
import { dirname } from 'path'
import { createHash } from 'crypto'
import type { SupervisorConfig } from './config'

const MAX_BYTES = 50 * 1024 * 1024 // 50 MB

export interface AuditEntry {
  ts: string
  run_id: string
  repo_path: string
  branch: string | null
  prompt_hash: string | null
  flags: Record<string, unknown>
  allowed: boolean
  reason?: string
}

/** SHA-256 hex hash of a prompt. Returns null when prompt is null/empty. */
export function hashPrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

/**
 * Append a single JSONL line to the audit log.
 *
 * Best-effort: never throws. Skipped when `cfg.auditLogEnabled === false`.
 * Rotates by renaming to `<path>.1` (overwriting any prior rotation) when the
 * file exceeds 50 MB.
 */
export function appendAudit(entry: AuditEntry, cfg: SupervisorConfig): void {
  if (!cfg.auditLogEnabled) return
  const path = cfg.auditLogPath
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      try {
        const sz = statSync(path).size
        if (sz >= MAX_BYTES) {
          renameSync(path, path + '.1')
        }
      } catch {
        // ignore stat/rename errors; continue appending
      }
    }
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // never throw on audit failure
  }
}
