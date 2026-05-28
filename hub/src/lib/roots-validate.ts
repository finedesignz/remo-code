/**
 * Phase 12 Wave 2 — supervisor root-path validation.
 *
 * The hub cannot stat paths on the supervisor's filesystem; validation is
 * shape-only. Rules:
 *   - max 16 entries
 *   - each entry: trimmed string, 1..512 chars
 *   - no NUL bytes
 *   - no `..` segments (path-traversal smell — the supervisor scanner walks
 *     these blindly so we refuse them at the API boundary)
 *   - must be absolute. Accepts either POSIX `/foo/bar` OR Windows drive-
 *     letter forms (`C:\foo`, `C:/foo`, or UNC `\\server\share`).
 *
 * Returns a discriminated result so the API handler can map to 400 with a
 * precise reason.
 */

export type RootsValidationResult =
  | { ok: true; roots: string[] }
  | { ok: false; error: string; index?: number; value?: string }

const MAX_ROOTS = 16
const MAX_LEN = 512

const POSIX_ABSOLUTE = /^\//
// Windows drive: optional, e.g. C: or C:\ or c:/. UNC: \\server\share.
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC = /^\\\\[^\\/]+[\\/][^\\/]+/

export function isAbsolutePath(p: string): boolean {
  return POSIX_ABSOLUTE.test(p) || WINDOWS_DRIVE.test(p) || WINDOWS_UNC.test(p)
}

export function validateRoots(input: unknown): RootsValidationResult {
  if (!Array.isArray(input)) return { ok: false, error: 'roots_not_array' }
  if (input.length > MAX_ROOTS) return { ok: false, error: 'too_many_roots' }

  const out: string[] = []
  for (let i = 0; i < input.length; i++) {
    const raw = input[i]
    if (typeof raw !== 'string') return { ok: false, error: 'root_not_string', index: i }
    const trimmed = raw.trim()
    if (trimmed.length === 0) return { ok: false, error: 'root_empty', index: i }
    if (trimmed.length > MAX_LEN) return { ok: false, error: 'root_too_long', index: i, value: trimmed.slice(0, 80) }
    if (trimmed.includes('\0')) return { ok: false, error: 'root_has_nul', index: i }
    // Reject parent-traversal segments. Normalize separators for the regex
    // (split on both / and \) so `..\evil` and `../evil` both reject.
    const segments = trimmed.split(/[\\/]+/)
    if (segments.some((s) => s === '..')) {
      return { ok: false, error: 'root_has_parent_traversal', index: i, value: trimmed }
    }
    if (!isAbsolutePath(trimmed)) {
      return { ok: false, error: 'root_not_absolute', index: i, value: trimmed }
    }
    out.push(trimmed)
  }
  // Dedupe — preserves order, removes exact duplicates only (case-sensitive;
  // Windows callers should send a canonical form).
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const r of out) {
    if (seen.has(r)) continue
    seen.add(r)
    deduped.push(r)
  }
  return { ok: true, roots: deduped }
}
