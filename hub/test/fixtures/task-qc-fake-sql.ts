/**
 * PTYCAP-08 strict statement-recording fake of the `sql` tag for the task-qc
 * suites. Generic on purpose: no schema knowledge, responders are registered per
 * test. Every statement is recorded with a kind; a statement with no responder
 * lands in state.unknown (assertNoUnknown() is the tripwire) so a query the
 * code under test issues that the test did not anticipate fails loudly.
 *
 * Not a mock.module call and not a test file: a suite does its own
 * `mock.module('../src/db/postgres.ts', () => ({ sql }))` if it needs to.
 */
export type StatementKind = 'select' | 'insert' | 'update' | 'delete' | 'lock' | 'set_local' | 'other'

export interface Recorded {
  text: string
  kind: StatementKind
  values: any[]
  /** the statement contains FOR UPDATE / FOR NO KEY UPDATE */
  forUpdate: boolean
  /** which transaction (0 = top level, n = nth begin()) */
  tx: number
}

export type Responder = any[] | ((values: any[], text: string) => any[])

export interface TaskQcFakeState {
  statements: Recorded[]
  unknown: string[]
  beginCalls: number
  /** mode strings passed to begin(mode, fn), e.g. 'read only' */
  beginModes: string[]
  lockCalls: number
  setLocalCalls: number
  /** insert, update and delete statements, in order */
  writes(): Recorded[]
  /** only UPDATE <table> statements */
  updatesTo(table: string): Recorded[]
}

const WRITE_KINDS: StatementKind[] = ['insert', 'update', 'delete']

export function classify(text: string): StatementKind {
  const t = text.trim()
  if (/pg_advisory_(xact_)?lock/i.test(t)) return 'lock'
  if (/^SET\s+LOCAL\b/i.test(t)) return 'set_local'
  const lead = /^(\w+)/.exec(t)?.[1]?.toUpperCase()
  if (lead === 'INSERT') return 'insert'
  if (lead === 'UPDATE') return 'update'
  if (lead === 'DELETE') return 'delete'
  if (lead === 'SELECT') return 'select'
  if (lead === 'WITH') {
    const m = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.exec(t)
    if (m) return m[1]!.toUpperCase().startsWith('INSERT') ? 'insert' : m[1]!.toUpperCase().startsWith('UPDATE') ? 'update' : 'delete'
    return 'select'
  }
  return 'other'
}

export function createTaskQcFakeSql() {
  const state: TaskQcFakeState = {
    statements: [],
    unknown: [],
    beginCalls: 0,
    beginModes: [],
    lockCalls: 0,
    setLocalCalls: 0,
    writes: () => state.statements.filter((s) => WRITE_KINDS.includes(s.kind)),
    updatesTo: (table) =>
      state.statements.filter((s) => s.kind === 'update' && new RegExp(`^UPDATE\\s+${table}\\b`, 'i').test(s.text)),
  }
  let responders: Array<{ pattern: string | RegExp; handler: Responder }> = []
  let failures: Array<{ pattern: string | RegExp; error: Error }> = []
  let currentTx = 0

  const matches = (pattern: string | RegExp, text: string) =>
    typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)

  function run(strings: TemplateStringsArray, values: any[]): any[] {
    const text = strings.join('?').replace(/\s+/g, ' ').trim()
    const kind = classify(text)
    state.statements.push({ text, kind, values, forUpdate: /\bFOR\s+(NO\s+KEY\s+)?UPDATE\b/i.test(text), tx: currentTx })
    if (kind === 'lock') state.lockCalls++
    if (kind === 'set_local') state.setLocalCalls++
    const fail = failures.find((f) => matches(f.pattern, text))
    if (fail) throw fail.error
    // first matching responder wins (register specific patterns first)
    const r = responders.find((x) => matches(x.pattern, text))
    if (r) return typeof r.handler === 'function' ? r.handler(values, text) : r.handler
    if (kind === 'lock' || kind === 'set_local') return []
    state.unknown.push(text)
    return []
  }

  const unsafe = (text: string) => {
    try {
      return Promise.resolve(run(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray, []))
    } catch (err) {
      return Promise.reject(err)
    }
  }
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    try {
      return Promise.resolve(run(strings, values))
    } catch (err) {
      return Promise.reject(err)
    }
  }
  sql.unsafe = unsafe
  sql.begin = async (a: any, b?: (tx: any) => Promise<any>) => {
    // postgres.js accepts begin(fn) and begin('read only', fn)
    const fn: (tx: any) => Promise<any> = typeof a === 'function' ? a : b!
    if (typeof a === 'string') state.beginModes.push(a)
    state.beginCalls++
    const prev = currentTx
    currentTx = state.beginCalls
    const tx: any = (strings: TemplateStringsArray, ...values: any[]) => sql(strings, ...values)
    tx.unsafe = sql.unsafe
    try {
      return await fn(tx)
    } finally {
      currentTx = prev
    }
  }

  const on = (pattern: string | RegExp, handler: Responder) => {
    responders.push({ pattern, handler })
  }

  return {
    sql,
    state,
    on,
    onSelect: (pattern: string | RegExp, handler: Responder) => on(pattern, handler),
    /** responder for an INSERT ... RETURNING clause */
    onInsert: (pattern: string | RegExp, handler: Responder) => on(pattern, handler),
    /** simulate a thrown statement */
    failOn: (pattern: string | RegExp, error: Error) => {
      failures.push({ pattern, error })
    },
    assertNoUnknown: () => {
      if (state.unknown.length > 0) {
        throw new Error(`task-qc fake sql: unanticipated statement(s):\n${state.unknown.join('\n')}`)
      }
    },
    reset: () => {
      responders = []
      failures = []
      currentTx = 0
      state.statements.length = 0
      state.unknown.length = 0
      state.beginCalls = 0
      state.beginModes.length = 0
      state.lockCalls = 0
      state.setLocalCalls = 0
    },
  }
}
