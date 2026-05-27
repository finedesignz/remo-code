/**
 * Phase 11 — pure project-type detector.
 *
 * Input: list of file/dir names at the repo root. Entries may include a
 * sentinel of the form `package.json:<raw-json-text>` so callers can pass
 * package.json contents alongside file presence without doing IO here.
 *
 * Rules (first match wins, per scope brief):
 *   1. tauri.conf.json present                       -> 'tauri'
 *   2. package.json deps contain "next" or "vite"    -> 'web-app'
 *   3. package.json deps contain "hono" or "express" -> 'api'
 *   4. Dockerfile present (no package.json match)    -> 'service'
 *   5. else                                          -> 'unknown'
 */
export type ProjectType = 'tauri' | 'web-app' | 'api' | 'service' | 'unknown'

export function detectProjectType(repoRootContents: string[]): ProjectType {
  const names = new Set<string>()
  let pkgRaw = ''
  for (const entry of repoRootContents) {
    if (entry.startsWith('package.json:')) {
      pkgRaw = entry.slice('package.json:'.length)
      names.add('package.json')
    } else {
      names.add(entry)
    }
  }
  if (names.has('tauri.conf.json')) return 'tauri'
  if (names.has('package.json')) {
    if (/"next"|"vite"/.test(pkgRaw)) return 'web-app'
    if (/"hono"|"express"/.test(pkgRaw)) return 'api'
  }
  if (names.has('Dockerfile')) return 'service'
  return 'unknown'
}
