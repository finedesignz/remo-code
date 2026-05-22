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

function gitSync(args: string[], cwd: string, timeoutMs = 5000): string | null {
  try {
    const result = Bun.spawnSync(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: timeoutMs,
    })
    if (result.exitCode !== 0) return null
    return new TextDecoder().decode(result.stdout)
  } catch { return null }
}

function isDirty(repoPath: string): boolean {
  const out = gitSync(['status', '--porcelain'], repoPath)
  if (out == null) return false
  return out.trim().length > 0
}

function lastCommit(repoPath: string): string | null {
  const out = gitSync(['log', '-1', '--pretty=%h%x09%s'], repoPath)
  return out?.trim() || null
}

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
      dirty: isDirty(path),
      last_commit: lastCommit(path),
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
