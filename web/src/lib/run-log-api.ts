/**
 * web/src/lib/run-log-api.ts
 * OBSRV-02 — typed client for GET /api/orchestrator/run-log.
 * Read-only consumer; zero hub-side changes.
 */
import { hubFetch } from './api';

/** Mirrors hub/src/db/orchestrator-rows-dal.ts RoutineRunLogEntry */
export interface RunLogEntry {
  id: string;
  session_id: string;
  repo_key: string | null;
  command: string;
  decision_rationale: string | null;
  outcome: string | null;
  gap_dimension: string | null;
  pr_url: string | null;
  reviewer_verdict: string | null;
  deploy_verify_result: string | null;
  created_at: string;
}

export interface RunLogPage {
  entries: RunLogEntry[];
  /** True when there are likely more rows (entries.length === limit). */
  hasMore: boolean;
}

export interface FetchRunLogOpts {
  token: string | null;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export async function fetchRunLog(opts: FetchRunLogOpts): Promise<RunLogPage> {
  const { token, sessionId, limit = 50, offset = 0 } = opts;
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (sessionId) params.set('session_id', sessionId);

  const raw = await hubFetch<{ items: RunLogEntry[]; limit: number; offset: number }>(
    token,
    `/api/orchestrator/run-log?${params}`,
  );

  // API returns { items: [...], limit, offset }
  const entries: RunLogEntry[] = raw?.items ?? [];

  return { entries, hasMore: entries.length === limit };
}
