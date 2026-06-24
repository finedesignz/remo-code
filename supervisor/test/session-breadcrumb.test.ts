/**
 * Idle-kill "write to memory before killing" breadcrumb.
 *
 * The supervisor drops a factual breadcrumb to its own dir before reaping a
 * hub-shutdown session. The write is best-effort/fail-open and must produce a
 * well-formed JSON record keyed by a filesystem-safe session id.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeSessionBreadcrumb, breadcrumbDir } from '../src/runners/session-breadcrumb'

let savedLocal: string | undefined
let tmp: string

beforeEach(() => {
  savedLocal = process.env.LOCALAPPDATA
  tmp = mkdtempSync(join(tmpdir(), 'remo-crumb-'))
  process.env.LOCALAPPDATA = tmp
})
afterEach(() => {
  if (savedLocal === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = savedLocal
})

describe('writeSessionBreadcrumb', () => {
  test('writes a well-formed breadcrumb keyed by session id', () => {
    const now = new Date('2026-06-24T12:00:00.000Z')
    const path = writeSessionBreadcrumb(
      { sessionId: 'sess-123', repoPath: 'C:/repo', reason: 'idle_no_subscribers', backend: 'pty' },
      now,
    )
    expect(path).not.toBeNull()
    expect(existsSync(path!)).toBe(true)
    const crumb = JSON.parse(readFileSync(path!, 'utf8'))
    expect(crumb.session_id).toBe('sess-123')
    expect(crumb.repo_path).toBe('C:/repo')
    expect(crumb.reason).toBe('idle_no_subscribers')
    expect(crumb.backend).toBe('pty')
    expect(crumb.killed_at).toBe('2026-06-24T12:00:00.000Z')
    expect(typeof crumb.hostname).toBe('string')
  })

  test('lands under the supervisor breadcrumb dir', () => {
    const path = writeSessionBreadcrumb(
      { sessionId: 'abc', repoPath: '/r', reason: 'r', backend: 'stream-json' },
      new Date('2026-06-24T00:00:00.000Z'),
    )
    expect(path!.startsWith(breadcrumbDir())).toBe(true)
  })

  test('sanitizes unsafe session ids and handles null id', () => {
    const now = new Date('2026-06-24T00:00:00.000Z')
    const p1 = writeSessionBreadcrumb({ sessionId: '../../evil', repoPath: '/r', reason: 'r', backend: 'unknown' }, now)
    expect(p1!).not.toContain('..')
    const p2 = writeSessionBreadcrumb({ sessionId: null, repoPath: '/r', reason: 'r', backend: 'unknown' }, now)
    expect(p2).not.toBeNull()
    expect(p2!).toContain('unknown-')
  })
})
