/**
 * PTYCAP-08 (F2-B4): the task_type literal set is carried by four independent
 * sources. This pins them against drift: every carrier must equal the schema
 * CHECK set minus a documented, per-carrier exemption table, and 'task_qc'
 * must be in all four. An unexplained new drift fails the test.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Remove // line comments, SQL -- line comments and block comments. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/--[^\n]*/g, '')
}

/** Text between the paren/bracket at `openIdx` and its balanced close. */
function balanced(s: string, openIdx: number): string {
  const open = s[openIdx]!
  const close = open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === open) depth++
    else if (s[i] === close) {
      depth--
      if (depth === 0) return s.slice(openIdx + 1, i)
    }
  }
  throw new Error('unbalanced extraction')
}

const literals = (s: string): string[] => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)

function schemaSet(): Set<string> {
  const sql = stripComments(read('db/schema.sql'))
  const marker = 'ADD CONSTRAINT scheduled_tasks_task_type_check'
  const first = sql.indexOf(marker)
  expect(first).toBeGreaterThanOrEqual(0)
  expect(sql.indexOf(marker, first + 1)).toBe(-1) // exactly one pair
  const checkIdx = sql.indexOf('CHECK', first)
  const body = balanced(sql, sql.indexOf('(', checkIdx))
  return new Set(literals(body))
}

function unionSet(rel: string, endMarker: string): Set<string> {
  const src = stripComments(read(rel))
  const start = src.indexOf('export type TaskType =')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = src.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return new Set(literals(src.slice(start, end)))
}

function zodSet(): Set<string> {
  const src = stripComments(read('api/scheduled-tasks.ts'))
  const start = src.indexOf('const TaskTypeEnum = z.enum(')
  expect(start).toBeGreaterThanOrEqual(0)
  const arr = balanced(src, src.indexOf('[', start))
  return new Set(literals(arr))
}

/** Pre-existing per-carrier drift. Every entry needs a reason. */
const EXEMPT: Record<'dal' | 'zod' | 'autoName', Record<string, string>> = {
  dal: {
    orchestrator: 'orchestrator rows are created by the orchestrator subsystem, never through the DAL TaskType path',
  },
  zod: {
    work: "'work' is machine-created only by /api/ext/work; the public create route must not accept it",
  },
  autoName: {
    work: "'work' tasks are machine-created with an explicit name; auto-name never builds them",
    orchestrator: 'orchestrator rows are created by the orchestrator subsystem with their own name',
  },
}

describe('PTYCAP-08 task_type enum sync', () => {
  const schema = schemaSet()
  const carriers = {
    dal: unionSet('db/scheduled-tasks-dal.ts', 'export type TargetKind'),
    zod: zodSet(),
    autoName: unionSet('scheduler/auto-name.ts', 'export type TargetKind'),
  } as const

  test('every exemption carries a non-empty reason', () => {
    for (const table of Object.values(EXEMPT)) {
      for (const reason of Object.values(table)) expect(reason.trim().length).toBeGreaterThan(0)
    }
  })

  test("'task_qc' is in the schema CHECK and all three code carriers", () => {
    expect(schema.has('task_qc')).toBe(true)
    for (const [name, set] of Object.entries(carriers)) {
      expect(set.has('task_qc'), `${name} missing task_qc`).toBe(true)
    }
  })

  for (const name of ['dal', 'zod', 'autoName'] as const) {
    test(`${name} equals the schema set minus its documented exemptions`, () => {
      const expected = new Set([...schema].filter((t) => !(t in EXEMPT[name])))
      expect([...carriers[name]].sort()).toEqual([...expected].sort())
    })

    test(`${name} exemptions are real (each exempted literal is in the schema set and absent from the carrier)`, () => {
      for (const t of Object.keys(EXEMPT[name])) {
        expect(schema.has(t)).toBe(true)
        expect(carriers[name].has(t)).toBe(false)
      }
    })
  }
})
