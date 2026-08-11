/**
 * Regression: a duplicate `insertAnnotation` call (same user_id +
 * annotation_id_external, i.e. a retried dispatch) must not silently
 * discard a newly-supplied `fix_contract` in `payload_raw`.
 *
 * `insertAnnotation`'s `INSERT ... ON CONFLICT (user_id, annotation_id_external)
 * DO UPDATE SET ...` previously listed only `callback_url` in its SET clause,
 * so `RETURNING *` handed the caller back the STALE row's `payload_raw` —
 * losing `fix_contract` on retry with no error and no log line. The prompt
 * builder (`renderAnnotationPrompt`, prompt.ts:87) reads
 * `(a.payload_raw as any)?.fix_contract` straight off that returned row, so
 * the agent silently reverted to ask-first behavior.
 *
 * This test exercises the REAL `insertAnnotation` (not a re-mocked stub)
 * against an in-memory `sql` double that mirrors Postgres upsert semantics
 * DERIVED FROM insertAnnotation's OWN literal SQL text (parses the actual
 * column list and the actual `DO UPDATE SET ... = EXCLUDED...` clause via
 * regex) rather than a hand-rolled reimplementation of "what it should do".
 * If the production SET clause is missing `payload_raw`, this mock — and
 * therefore this test — reproduces exactly that bug; once the SET clause
 * includes `payload_raw`, the mock (and the test) reflects that fix.
 *
 * Implementation note: other test files mocking `../src/db/postgres.ts` are
 * process-global (Bun `mock.module`) and can be last-registration-wins
 * across files. We re-register in `beforeEach` and re-import the DAL via a
 * cache-busting query suffix (matches `insert-run-started-at.test.ts`) so
 * this file is robust to suite ordering.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ── In-memory Postgres double for `annotations` upserts ─────────────────────

let table: Map<string, any>
let idSeq: number

function installMocks() {
  table = new Map()
  idSeq = 0

  const sqlFn: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join('')

    if (text.includes('INSERT INTO annotations')) {
      const colListMatch = text.match(/INSERT INTO\s+annotations\s*\(([^)]+)\)/)
      if (!colListMatch) throw new Error('mock sql: could not parse annotations column list')
      const cols = colListMatch[1].split(',').map((c) => c.trim())

      const incoming: Record<string, any> = {}
      cols.forEach((col, i) => { incoming[col] = values[i] })

      const key = `${incoming.user_id}::${incoming.annotation_id_external}`

      // Parse the ACTUAL `DO UPDATE SET col = EXCLUDED.col, ...` clause from
      // the real query text — this is what makes the mock faithful to
      // whatever insertAnnotation's SQL literally says, pre- or post-fix.
      const setClauseMatch = text.match(/DO UPDATE\s+SET([\s\S]*?)RETURNING/)
      const updateCols = setClauseMatch
        ? Array.from(setClauseMatch[1].matchAll(/(\w+)\s*=\s*EXCLUDED\.\1/g)).map((m) => m[1])
        : []

      const existing = table.get(key)
      if (existing) {
        for (const col of updateCols) existing[col] = incoming[col]
        return [existing]
      }

      idSeq++
      const row = {
        id: `ann-${idSeq}`,
        status: 'pending',
        skip_reason: null,
        session_id: null,
        dispatched_at: null,
        resolved_at: null,
        received_at: new Date().toISOString(),
        ...incoming,
      }
      table.set(key, row)
      return [row]
    }

    return []
  }
  sqlFn.json = (v: any) => v // identity, matching orchestrator-propose.test.ts / propose-notify.test.ts

  mock.module('../src/db/postgres.ts', () => ({ sql: sqlFn }))
  mock.module('../src/db/postgres', () => ({ sql: sqlFn }))
}

async function freshRevanoteDal() {
  return await import(`../src/db/revanote-dal.ts?t=${Date.now()}${Math.random()}`)
}

function basePayload(over: Partial<any> = {}) {
  return {
    user_id: 'user-1',
    annotation_id_external: 'ext-retry-1',
    page_url: 'https://demo.example.com/page',
    annotation_url: 'https://revanote.app/a/ext-retry-1',
    screenshot_url: null,
    x: 10,
    y: 20,
    element_selector: '.btn',
    comment: 'fix this button',
    replies_json: [],
    callback_url: 'https://revanote.app/cb',
    mapping_id: null,
    source_ip: null,
    payload_raw: {},
    ...over,
  }
}

describe('insertAnnotation — duplicate dispatch must not discard fix_contract', () => {
  beforeEach(() => {
    installMocks()
  })

  test('retried dispatch carrying fix_contract is reflected in the returned row', async () => {
    const dal = await freshRevanoteDal()

    // First dispatch: no fix_contract yet (pre-Phase-5 style payload).
    const first = await dal.insertAnnotation(basePayload({ payload_raw: {} }))
    expect(first.payload_raw).toEqual({})

    // Retry of the SAME annotation (same user_id + annotation_id_external),
    // this time carrying a fix_contract block.
    const fixContract = { version: 1, default: 'best_guess', ask_reasons: ['ambiguous_intent'] }
    const second = await dal.insertAnnotation(
      basePayload({ payload_raw: { fix_contract: fixContract } }),
    )

    // Same row (idempotent upsert) — but MUST carry the fresh fix_contract,
    // not the stale payload_raw from the first insert.
    expect(second.id).toBe(first.id)
    expect(second.payload_raw?.fix_contract).toEqual(fixContract)
  })

  test('the prompt layer sees fix_contract off the retried-dispatch row', async () => {
    const dal = await freshRevanoteDal()
    const { renderAnnotationPrompt } = await import(
      `../src/revanote/prompt.ts?t=${Date.now()}${Math.random()}`
    )

    await dal.insertAnnotation(basePayload({ payload_raw: {} }))
    const fixContract = { version: 1, default: 'best_guess', ask_reasons: ['ambiguous_intent'] }
    const retried = await dal.insertAnnotation(
      basePayload({ payload_raw: { fix_contract: fixContract } }),
    )

    const prompt = renderAnnotationPrompt({ annotation: retried, mapping: null })

    // The prompt builder only emits the best-guess-default instructions and
    // the `"assumption"` envelope key when `payload_raw.fix_contract` is
    // truthy (prompt.ts:87, 121-138). A stale payload_raw would silently
    // fall back to the pre-Phase-5 ask-first prompt.
    expect(prompt).toContain('Fix contract: attempt a reasonable best-guess default')
    expect(prompt).toContain('"assumption":')
  })

  test('a thinner retry dispatch (no fix_contract) does NOT clobber a previously-stored fix_contract', async () => {
    const dal = await freshRevanoteDal()

    // First dispatch: rich payload carrying a fix_contract.
    const fixContract = { version: 1, default: 'best_guess', ask_reasons: ['ambiguous_intent'] }
    const first = await dal.insertAnnotation(
      basePayload({ payload_raw: { fix_contract: fixContract } }),
    )
    expect(first.payload_raw?.fix_contract).toEqual(fixContract)

    // Late/out-of-order duplicate for the SAME annotation, this time with a
    // thinner payload_raw that lacks fix_contract entirely (e.g. an
    // older/duplicate dispatch that arrives after the enriched one).
    const second = await dal.insertAnnotation(basePayload({ payload_raw: {} }))

    // Same row (idempotent upsert) — the previously-stored fix_contract must
    // survive; an absent fix_contract on retry must never erase a stored one.
    expect(second.id).toBe(first.id)
    expect(second.payload_raw?.fix_contract).toEqual(fixContract)
  })
})
