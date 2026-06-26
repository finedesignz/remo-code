// hub/test/e2e/orchestrator-harness.ts
// Milestone OEE (Orchestrator E2E Prove-Out) — Phases OEE-01 + OEE-02.
//
// A REUSABLE, ISOLATED e2e harness that lets later phases (OEE-03..05) drive the
// already-merged, flag-gated-OFF Auto-Dev Orchestrator + TMAC macro path against a
// REAL Postgres plus a scripted bound-session sink — never prod, never the prod DB.
//
// This is PURE VALIDATION/TEST code:
//   - ZERO changes to hub/src/db/schema.sql (we run it UNMODIFIED).
//   - NO production-runtime seam added — the orchestrator already exposes clean DI
//     seams (`injectOrchestratorPrompt(input, deps)` and `runMacroCycle(input, deps:
//     MacroCycleDeps)`). The sink plugs into THOSE existing seams; nothing in
//     hub/src/ is touched, so live behavior is unchanged by definition.
//   - Cost cap is never weakened: the sink replaces the *inject adapter* (the seam
//     above `dispatch`), so when a phase wants to prove the cap it uses the REAL
//     `injectOrchestratorPrompt` against the real `dailyCostCapGate` instead.
//
// Conventions mirror hub/test/phase-08.e2e.test.ts:
//   - gate on env REMO_E2E_DB_URL (`hasE2eDb()` / `maybeDescribe`).
//   - open a private `postgres` client against REMO_E2E_DB_URL (NEVER the ambient
//     prod DATABASE_URL).
//   - cascade-delete teardown via the synthetic user row.
//   - describe.skip when no test DB so `bun run check-baseline` stays green.

import postgres from 'postgres';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe } from 'bun:test';
import { splitSqlStatements } from '../../src/db/migrate.ts';
import { parseSentinels, type ParsedSentinels } from '../../src/orchestrator/sentinels.ts';
import type { InjectInput, InjectOutcome } from '../../src/orchestrator/inject.ts';
import type { MacroCycleDeps } from '../../src/orchestrator/macro-cycle.ts';
import type { NewRoutineRunLogEntry, RoutineRunLogEntry } from '../../src/orchestrator/run-log.ts';

// ── E2E gate ─────────────────────────────────────────────────────────────────

/** True when a disposable Postgres URL is provided. */
export function hasE2eDb(): boolean {
  return !!process.env.REMO_E2E_DB_URL;
}

/** `describe` when REMO_E2E_DB_URL is set, else `describe.skip` (CI-safe). */
export const maybeDescribe = hasE2eDb() ? describe : describe.skip;

// ── Non-prod DSN guard (OEE-01) ──────────────────────────────────────────────
//
// Conservative by design: refusing to run is ALWAYS safe. The guard rejects a DSN
// that (a) carries a known prod marker, or (b) points at a non-local host without
// an explicit REMO_E2E_ALLOW_NONLOCAL=1 opt-in. It NEVER consults the ambient
// prod DATABASE_URL — the harness connects only via REMO_E2E_DB_URL.

/** Substrings that mark the Coolify prod DB / public prod surface — hard reject. */
const PROD_DSN_MARKERS = [
  'coolify',
  'titaniumlabs',
  'remo-code.com',
  'app.remo-code',
  '46.224.61.233', // prod host IP (infrastructure.md)
  'supabase.co',
  'rds.amazonaws.com',
  'neon.tech',
  'pooler.', // managed poolers (supabase/neon style)
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

export class ProdDsnRefusedError extends Error {
  constructor(reason: string) {
    super(`[orchestrator-harness] refusing to run against this DSN: ${reason}`);
    this.name = 'ProdDsnRefusedError';
  }
}

/** Lower-cased host of a postgres DSN, or '' if unparseable. */
function dsnHost(dsn: string): string {
  try {
    // `postgres://` URLs parse with the URL constructor; password may contain
    // chars URL tolerates. hostname is lower-cased + brackets stripped for ipv6.
    const u = new URL(dsn);
    return (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * Throw `ProdDsnRefusedError` if `dsn` looks like prod OR is a non-local host
 * without REMO_E2E_ALLOW_NONLOCAL=1. Conservative: ambiguous → refuse.
 *
 * @param allowNonLocal override the env opt-in (tests pass `true`/`false`
 *   explicitly so the assertion is deterministic).
 */
export function assertNonProdDsn(
  dsn: string | undefined | null,
  allowNonLocal: boolean = process.env.REMO_E2E_ALLOW_NONLOCAL === '1',
): asserts dsn is string {
  if (!dsn || !dsn.trim()) {
    throw new ProdDsnRefusedError('empty DSN');
  }
  const lower = dsn.toLowerCase();
  for (const marker of PROD_DSN_MARKERS) {
    if (lower.includes(marker)) {
      throw new ProdDsnRefusedError(`DSN contains prod marker "${marker}"`);
    }
  }
  const host = dsnHost(dsn);
  if (!LOCAL_HOSTS.has(host) && !allowNonLocal) {
    throw new ProdDsnRefusedError(
      `non-local host "${host}" without REMO_E2E_ALLOW_NONLOCAL=1 opt-in`,
    );
  }
}

// ── Schema boot / teardown (OEE-01) ──────────────────────────────────────────

const SCHEMA_PATH = resolve(import.meta.dir, '../../src/db/schema.sql');

export interface Harness {
  /** Private client bound to REMO_E2E_DB_URL (NOT the hub's shared `sql`). */
  sql: ReturnType<typeof postgres>;
  /** The disposable DSN this harness is bound to (already guard-checked). */
  dsn: string;
  /** Synthetic user seeded for FK references; cascade-deleted on teardown. */
  userId: string;
  /** Synthetic user's email (unique per harness). */
  email: string;
  /** A seeded session row (FK target for routine_run_log etc.). */
  sessionId: string;
}

/**
 * Boot the REAL `hub/src/db/schema.sql` (UNMODIFIED) against the disposable DB and
 * seed one synthetic user. Idempotent — schema.sql is designed to re-run every
 * boot, so calling setupHarness twice against the same DB is safe.
 *
 * Guard order: assertNonProdDsn FIRST (refuse-to-run is safe), then connect.
 */
export async function setupHarness(opts?: { dsn?: string }): Promise<Harness> {
  const dsn = opts?.dsn ?? process.env.REMO_E2E_DB_URL;
  assertNonProdDsn(dsn);

  const sql = postgres(dsn, { max: 4, idle_timeout: 5, connect_timeout: 10 });

  // Apply schema.sql statement-by-statement (same splitter the hub boot uses),
  // best-effort per statement so an already-applied idempotent DDL re-run is fine.
  const ddl = readFileSync(SCHEMA_PATH, 'utf-8');
  const statements = splitSqlStatements(ddl);
  for (const stmt of statements) {
    try {
      await sql.unsafe(stmt);
    } catch (err: any) {
      // schema.sql is idempotent; a benign re-run conflict is expected. Surface
      // anything unexpected loudly but do NOT abort the whole boot.
      console.warn(`[harness] schema stmt skipped: ${stmt.slice(0, 70)}… — ${err?.message}`);
    }
  }

  const email = `e2e-oee-${randomUUID()}@invalid.local`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash, role)
    VALUES (${email}, 'x', 'user')
    RETURNING id
  `;

  const userId = rows[0].id;

  // Seed one session row so FK-bearing tables (routine_run_log, orchestrator_rows,
  // routine_queue) have a valid target. Minimal required columns only.
  const sessRows = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, name, project_dir, token_hash)
    VALUES (${userId}, 'oee-harness', '/tmp/oee-harness', ${'th-' + randomUUID()})
    RETURNING id
  `;

  return { sql, dsn, userId, email, sessionId: sessRows[0].id };
}

/** Cascade-delete the synthetic user (FKs ON DELETE CASCADE) and close the pool. */
export async function teardownHarness(h: Harness): Promise<void> {
  try {
    await h.sql`DELETE FROM users WHERE id = ${h.userId}`;
  } finally {
    await h.sql.end({ timeout: 5 });
  }
}

// ── Scripted bound-session sink (OEE-02) ─────────────────────────────────────
//
// A fake session injection target. It CAPTURES every prompt the orchestrator
// injects and REPLAYS caller-supplied canned agent replies (containing
// <<STATE>>/<<NOTIFY>>/<<GATE>> sentinel blocks), deterministically and with NO
// live `claude` subprocess.
//
// It plugs into the EXISTING `MacroCycleDeps` DI seam of `runMacroCycle`:
//   - `inject`            → captures the InjectInput, returns a canned outcome.
//   - `getLatestAssistantReply` → returns the next scripted reply for that
//                           session, so the controller's RECONCILE step parses
//                           real sentinels via the real sentinels.ts.
//   - `appendRunLog`      → optionally writes through to the real run-log (when a
//                           harness `sql` is provided) or captures in-memory.
//   - `fanOut` / `isRunLive` → stubs the sink controls (notify captured, lock off).
//
// NOTHING in hub/src is monkeypatched — this is the orchestrator's own seam.

export interface CapturedInject {
  input: InjectInput;
  at: number;
}

export interface CapturedNotify {
  userId: string;
  sessionId: string;
  event: string;
  level: string;
  detail: string;
  channels: unknown;
  at: number;
}

export interface SinkOptions {
  /**
   * Canned assistant replies, consumed FIFO per RECONCILE call. Each entry is the
   * raw text of one prior agent turn (may contain sentinel blocks). When the queue
   * empties, `getLatestAssistantReply` returns null (no prior turn → no reconcile).
   */
  replies?: string[];
  /** Outcome `inject` returns for each captured prompt (default `dispatched`). */
  injectOutcome?: InjectOutcome;
  /** When provided, run-log writes go through to the REAL table; else in-memory. */
  sql?: ReturnType<typeof postgres>;
  /** Forces the per-session run-lock state the cycle sees (default: not live). */
  isRunLive?: boolean;
}

export interface ScriptedSink {
  /** The MacroCycleDeps to hand to `runMacroCycle(input, deps)`. */
  deps: MacroCycleDeps;
  /** Every prompt the orchestrator injected, in order. */
  captured: CapturedInject[];
  /** Every notify fan-out the cycle requested, in order. */
  notifies: CapturedNotify[];
  /** Run-log rows captured in-memory (also written to DB when `sql` supplied). */
  runLog: NewRoutineRunLogEntry[];
  /** Push another canned reply onto the FIFO at runtime. */
  pushReply: (reply: string) => void;
  /** Parse the LAST captured reply through the REAL sentinels.ts (convenience). */
  parseLastReply: () => ParsedSentinels | null;
  /** The replies the sink will/ did replay, in order. */
  repliesLog: string[];
}

/**
 * Build a scripted bound-session sink wired into the orchestrator's MacroCycleDeps
 * seam. Deterministic; no network, no subprocess.
 */
export function createScriptedSink(opts: SinkOptions = {}): ScriptedSink {
  const replies: string[] = [...(opts.replies ?? [])];
  const repliesLog: string[] = [];
  const captured: CapturedInject[] = [];
  const notifies: CapturedNotify[] = [];
  const runLog: NewRoutineRunLogEntry[] = [];
  const injectOutcome: InjectOutcome = opts.injectOutcome ?? { kind: 'dispatched' };

  const deps: MacroCycleDeps = {
    getLatestAssistantReply: async (_sessionId, _userId) => {
      const next = replies.shift();
      if (next == null) return null;
      repliesLog.push(next);
      return next;
    },
    appendRunLog: (async (entry: NewRoutineRunLogEntry): Promise<RoutineRunLogEntry> => {
      runLog.push(entry);
      if (opts.sql) {
        const dal = await import('../../src/orchestrator/run-log.ts');
        return dal.appendRunLog(entry);
      }
      // In-memory stand-in row (no DB).
      return {
        id: randomUUID(),
        session_id: entry.session_id,
        repo_key: entry.repo_key ?? null,
        command: entry.command,
        decision_rationale: entry.decision_rationale ?? null,
        outcome: entry.outcome ?? null,
        gap_dimension: entry.gap_dimension ?? null,
        pr_url: entry.pr_url ?? null,
        reviewer_verdict: entry.reviewer_verdict ?? null,
        deploy_verify_result: entry.deploy_verify_result ?? null,
        created_at: new Date().toISOString(),
      };
    }) as MacroCycleDeps['appendRunLog'],
    inject: (async (input: InjectInput): Promise<InjectOutcome> => {
      captured.push({ input, at: Date.now() });
      return injectOutcome;
    }) as MacroCycleDeps['inject'],
    fanOut: (async (ev: any): Promise<void> => {
      notifies.push({
        userId: ev.userId,
        sessionId: ev.sessionId,
        event: ev.event,
        level: ev.level,
        detail: ev.detail,
        channels: ev.channels,
        at: Date.now(),
      });
    }) as MacroCycleDeps['fanOut'],
    isRunLive: () => opts.isRunLive ?? false,
  };

  return {
    deps,
    captured,
    notifies,
    runLog,
    repliesLog,
    pushReply: (reply: string) => replies.push(reply),
    parseLastReply: () => {
      const last = repliesLog[repliesLog.length - 1];
      return last == null ? null : parseSentinels(last);
    },
  };
}
