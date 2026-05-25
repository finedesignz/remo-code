/**
 * error_setup_probe — read repo files so the hub can detect what SDK
 * (Sentry, Next.js, Django, etc.) the project uses.
 *
 * RPC contract:
 *   args: [repoPath, ...probeFilesRelativeToRepo]
 *
 * - Each probe file is read; missing files are silently skipped.
 * - Top-level glob (`*.py`, `*.ts`, etc.) is expanded against the repo root only.
 * - Total returned content size is capped at 1 MB → error 'probe_too_large'.
 *
 * Reply shape (delivered by the dispatcher as run_finished):
 *   success → { exit_code: 0, snippet: JSON.stringify({ files: [{path, content}] }) }
 *   fail    → { exit_code: 1, error: 'repo_not_found' | 'permission_denied'
 *                                     | 'read_error' | 'probe_too_large' }
 */
import { existsSync, statSync, readdirSync, readFileSync } from 'fs'
import { join, isAbsolute } from 'path'

export interface ProbeResult {
  ok: boolean
  files?: Array<{ path: string; content: string }>
  error?: string
}

const MAX_TOTAL_BYTES = 1 * 1024 * 1024 // 1 MB

function isGlob(pat: string): boolean {
  return pat.includes('*') || pat.includes('?')
}

function expandTopLevelGlob(repoPath: string, pattern: string): string[] {
  // Only support a simple top-level glob like `*.py` / `*.ts`.
  // Nested patterns (`src/**/*.ts`) intentionally unsupported here — probe
  // entries are always shallow project-marker files in PR #17.
  const m = pattern.match(/^\*\.([A-Za-z0-9]+)$/)
  if (!m) return []
  const ext = '.' + m[1].toLowerCase()
  try {
    return readdirSync(repoPath)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .filter((f) => {
        try { return statSync(join(repoPath, f)).isFile() } catch { return false }
      })
  } catch {
    return []
  }
}

export async function runErrorSetupProbe(args: string[]): Promise<ProbeResult> {
  if (!args || args.length < 1) {
    return { ok: false, error: 'read_error' }
  }
  const repoPath = args[0]
  const probeFiles = args.slice(1)

  if (!repoPath || !isAbsolute(repoPath)) {
    return { ok: false, error: 'repo_not_found' }
  }
  if (!existsSync(repoPath)) {
    return { ok: false, error: 'repo_not_found' }
  }
  try {
    if (!statSync(repoPath).isDirectory()) return { ok: false, error: 'repo_not_found' }
  } catch {
    return { ok: false, error: 'permission_denied' }
  }

  // Expand any globs against repo root
  const resolved: string[] = []
  const seen = new Set<string>()
  for (const entry of probeFiles) {
    if (!entry || typeof entry !== 'string') continue
    if (entry.includes('..')) continue // refuse path traversal
    if (isGlob(entry)) {
      for (const f of expandTopLevelGlob(repoPath, entry)) {
        if (!seen.has(f)) { seen.add(f); resolved.push(f) }
      }
    } else {
      if (!seen.has(entry)) { seen.add(entry); resolved.push(entry) }
    }
  }

  const out: Array<{ path: string; content: string }> = []
  let totalBytes = 0
  for (const rel of resolved) {
    const abs = join(repoPath, rel)
    if (!existsSync(abs)) continue // silently skip missing
    let content: string
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      totalBytes += st.size
      if (totalBytes > MAX_TOTAL_BYTES) {
        return { ok: false, error: 'probe_too_large' }
      }
      content = readFileSync(abs, 'utf-8')
    } catch (err: any) {
      const code = err?.code
      if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'permission_denied' }
      return { ok: false, error: 'read_error' }
    }
    out.push({ path: rel, content })
  }

  return { ok: true, files: out }
}
