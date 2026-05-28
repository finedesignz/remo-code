/**
 * TRIAGE-2026-05-28 Bundle 6 step 3.
 *
 * Verifies the SQL queries built by listMessages + getMessagesForSessions
 * carry the (created_at, seq) tiebreaker so same-millisecond inserts come
 * back in deterministic, monotonic order.
 *
 * Strategy: mock the postgres tagged template to capture the assembled SQL
 * string. No live DB needed — the assertion is over the query text.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

let captured: string[] = []

// Mock the hub's postgres wrapper BEFORE importing the DAL — both dal.ts
// and chat-tabs-dal.ts pull the `sql` tag from ./postgres.ts at module top
// so this must register first.
mock.module('../src/db/postgres.ts', () => {
  const sql: any = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    captured.push(strings.join('?'))
    return Promise.resolve([])
  }
  return { sql }
})

beforeEach(() => { captured = [] })

describe('SQL ORDER BY tiebreakers', () => {
  test('listMessages orders by (created_at ASC, seq ASC)', async () => {
    const { listMessages } = await import('../src/db/dal.ts')
    await listMessages('sess_x', 'user_x')
    const q = captured.join('\n')
    expect(q).toContain('ORDER BY m.created_at ASC, m.seq ASC')
  })

  test('getMessagesForSessions ranks DESC and outer-orders by (created_at ASC, seq ASC)', async () => {
    const { getMessagesForSessions } = await import('../src/db/chat-tabs-dal.ts')
    await getMessagesForSessions('user_x', ['sess_a'], 10)
    const q = captured.join('\n')
    expect(q).toContain('ORDER BY m.created_at DESC, m.seq DESC')
    expect(q).toContain('ORDER BY session_id, created_at ASC, seq ASC')
  })
})
