import { readdirSync, statSync, existsSync, readFileSync } from 'fs'
import { join, basename } from 'path'

export interface ScannedRepo {
  path: string
  name: string
  remote: string | null
  branch: string | null
  dirty: boolean
  last_commit: string | null
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

function readRemote(repoPath: string): string | null {
  try {
    const cfgPath = join(repoPath, '.git', 'config')
    if (!existsSync(cfgPath)) return null
    const cfg = readFileSync(cfgPath, 'utf-8')
    const m = cfg.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/m)
    return m ? m[1].trim() : null
  } catch { return null }
}

function readBranch(repoPath: string): string | null {
  try {
    const headPath = join(repoPath, '.git', 'HEAD')
    if (!existsSync(headPath)) return null
    const head = readFileSync(headPath, 'utf-8').trim()
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
    return head.slice(0, 12)
  } catch { return null }
}

// Note: deliberately avoiding `git status` / `git log` here — spawning git for every repo
// makes scan O(N) slow on Windows (~200ms per spawn). dirty/last_commit can be loaded
// lazily on demand if needed; for the picker we only need name, remote, branch.

export function scanRoot(root: string): ScannedRepo[] {
  const out: ScannedRepo[] = []
  if (!isDir(root)) return out
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return out }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const path = join(root, entry)
    if (!isDir(path)) continue
    if (!existsSync(join(path, '.git'))) continue
    out.push({
      path: path.replace(/\\/g, '/'),
      name: basename(path),
      remote: readRemote(path),
      branch: readBranch(path),
      dirty: false,
      last_commit: null,
    })
  }
  return out
}

export function scanAll(roots: string[]): ScannedRepo[] {
  const all: ScannedRepo[] = []
  const seen = new Set<string>()
  for (const r of roots) {
    for (const repo of scanRoot(r)) {
      if (seen.has(repo.path)) continue
      seen.add(repo.path)
      all.push(repo)
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name))
}
