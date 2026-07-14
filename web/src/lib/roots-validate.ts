/**
 * Client-side mirror of the hub's supervisor root-path validation
 * (`hub/src/lib/roots-validate.ts`). Kept in lockstep so the Connections roots
 * editor can reject a bad path inline before the PATCH round-trip. The server
 * remains authoritative — this is UX sugar, not a security boundary.
 *
 * Rules (must match the hub):
 *   - trimmed, 1..512 chars, no NUL
 *   - no `..` (parent-traversal) segments
 *   - absolute (POSIX `/foo`, Windows `C:\foo` / `C:/foo`, or UNC `\\server\share`)
 *   - not a drive-root-only path (`C:\`, `/`)
 *   - not a system directory
 *   - max 16 roots per supervisor
 */

export const MAX_ROOTS = 16
const MAX_LEN = 512

const POSIX_ABSOLUTE = /^\//
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC = /^\\\\[^\\/]+[\\/][^\\/]+/
const DRIVE_ROOT_ONLY = /^([A-Za-z]:[\\/]?|\/)$/

const SYSTEM_DIR_PREFIXES = [
  'c:\\windows', 'c:/windows',
  'c:\\program files', 'c:/program files',
  'c:\\program files (x86)', 'c:/program files (x86)',
  'c:\\programdata', 'c:/programdata',
  '/etc', '/sys', '/proc', '/dev', '/boot', '/root',
  '/var/log', '/var/lib', '/usr/bin', '/usr/sbin', '/bin', '/sbin',
]

function isSystemDir(p: string): boolean {
  const lower = p.toLowerCase()
  for (const prefix of SYSTEM_DIR_PREFIXES) {
    if (lower === prefix) return true
    if (lower.startsWith(prefix + '/') || lower.startsWith(prefix + '\\')) return true
  }
  return false
}

export function isAbsolutePath(p: string): boolean {
  return POSIX_ABSOLUTE.test(p) || WINDOWS_DRIVE.test(p) || WINDOWS_UNC.test(p)
}

/**
 * Validate a single candidate root path. Returns a human-readable error string,
 * or null when the path is well-formed. Does NOT check for duplicates — the
 * caller compares against the existing list.
 */
export function validateRoot(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'Enter a folder path'
  if (trimmed.length > MAX_LEN) return 'Path is too long'
  if (trimmed.includes('\0')) return 'Path contains an invalid character'
  const segments = trimmed.split(/[\\/]+/)
  if (segments.some((s) => s === '..')) return 'Path cannot contain ".." segments'
  if (!isAbsolutePath(trimmed)) return 'Path must be absolute (e.g. D:\\ClientWork or /home/me/work)'
  if (DRIVE_ROOT_ONLY.test(trimmed)) return 'A whole drive root is too broad — pick a subfolder'
  if (isSystemDir(trimmed)) return 'System directories cannot be scan roots'
  return null
}
