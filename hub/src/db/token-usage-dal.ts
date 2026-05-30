/**
 * P2 usage ledger — data-access for token_usage + token_usage_daily.
 *
 * recordTokenUsage() inserts one ledger row per assistant turn and upserts the
 * per-(user, day, model) rollup in a single statement set. P2 RECORDS only —
 * nothing here touches the cost cap (that's P3).
 *
 * Aggregation helpers back GET /api/usage/cost (today / 7d / total + per-session
 * + per-repo). All queries are scoped by user_id.
 */
import { sql } from './postgres.ts'

export interface TokenUsageInput {
  userId: string
  sessionId: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  costUsd: number
  costSource: 'sdk' | 'estimated'
}

/**
 * Insert a ledger row + upsert the daily rollup. The daily `day` is derived
 * from now() in UTC (the rollup is a coarse cache; the precise per-window
 * aggregates use token_usage.created_at directly).
 */
export async function recordTokenUsage(u: TokenUsageInput): Promise<{ id: string }> {
  const model = u.model ?? null
  const dailyModel = model ?? '' // PK column is NOT NULL; '' = unknown bucket
  const rows = await sql<{ id: string }[]>`
    INSERT INTO token_usage (
      user_id, session_id, model,
      input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens,
      cost_usd, cost_source
    ) VALUES (
      ${u.userId}, ${u.sessionId}, ${model},
      ${u.inputTokens}, ${u.outputTokens},
      ${u.cacheCreationInputTokens}, ${u.cacheReadInputTokens},
      ${u.costUsd}, ${u.costSource}
    )
    RETURNING id
  `
  await sql`
    INSERT INTO token_usage_daily (
      user_id, day, model,
      input_tokens, output_tokens,
      cache_creation_input_tokens, cache_read_input_tokens,
      cost_usd, updated_at
    ) VALUES (
      ${u.userId}, (now() AT TIME ZONE 'UTC')::date, ${dailyModel},
      ${u.inputTokens}, ${u.outputTokens},
      ${u.cacheCreationInputTokens}, ${u.cacheReadInputTokens},
      ${u.costUsd}, now()
    )
    ON CONFLICT (user_id, day, model) DO UPDATE SET
      input_tokens                = token_usage_daily.input_tokens + EXCLUDED.input_tokens,
      output_tokens               = token_usage_daily.output_tokens + EXCLUDED.output_tokens,
      cache_creation_input_tokens = token_usage_daily.cache_creation_input_tokens + EXCLUDED.cache_creation_input_tokens,
      cache_read_input_tokens     = token_usage_daily.cache_read_input_tokens + EXCLUDED.cache_read_input_tokens,
      cost_usd                    = token_usage_daily.cost_usd + EXCLUDED.cost_usd,
      updated_at                  = now()
  `
  return rows[0]!
}

export interface UsageTotals {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_usd: number
}

function rowToTotals(r: any): UsageTotals {
  return {
    input_tokens: Number(r?.input_tokens ?? 0),
    output_tokens: Number(r?.output_tokens ?? 0),
    cache_creation_input_tokens: Number(r?.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: Number(r?.cache_read_input_tokens ?? 0),
    cost_usd: Number(r?.cost_usd ?? 0),
  }
}

/**
 * today / 7d / total token+cost windows for a user, in the user's IANA tz.
 * Reads token_usage directly (precise; the daily rollup is only a cache).
 */
export async function sumUserTokenWindows(userId: string, timezone: string): Promise<{
  today: UsageTotals
  seven_day: UsageTotals
  total: UsageTotals
}> {
  const tz = timezone || 'UTC'
  const rows = await sql<any[]>`
    SELECT
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}), 0) AS today_input,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}), 0) AS today_output,
      COALESCE(SUM(cache_creation_input_tokens) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}), 0) AS today_cc,
      COALESCE(SUM(cache_read_input_tokens) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}), 0) AS today_cr,
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}), 0) AS today_cost,

      COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS week_input,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS week_output,
      COALESCE(SUM(cache_creation_input_tokens) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS week_cc,
      COALESCE(SUM(cache_read_input_tokens) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS week_cr,
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS week_cost,

      COALESCE(SUM(input_tokens), 0) AS total_input,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS total_cc,
      COALESCE(SUM(cache_read_input_tokens), 0) AS total_cr,
      COALESCE(SUM(cost_usd), 0) AS total_cost
    FROM token_usage
    WHERE user_id = ${userId}
  `
  const r = rows[0] ?? {}
  return {
    today: rowToTotals({
      input_tokens: r.today_input, output_tokens: r.today_output,
      cache_creation_input_tokens: r.today_cc, cache_read_input_tokens: r.today_cr,
      cost_usd: r.today_cost,
    }),
    seven_day: rowToTotals({
      input_tokens: r.week_input, output_tokens: r.week_output,
      cache_creation_input_tokens: r.week_cc, cache_read_input_tokens: r.week_cr,
      cost_usd: r.week_cost,
    }),
    total: rowToTotals({
      input_tokens: r.total_input, output_tokens: r.total_output,
      cache_creation_input_tokens: r.total_cc, cache_read_input_tokens: r.total_cr,
      cost_usd: r.total_cost,
    }),
  }
}

export interface SessionUsageRow extends UsageTotals {
  session_id: string | null
  session_name: string | null
  project_dir: string | null
}

/** Per-session breakdown (last `limit` sessions by spend). */
export async function usageBySession(userId: string, limit = 50): Promise<SessionUsageRow[]> {
  const cap = Math.min(Math.max(limit, 1), 200)
  const rows = await sql<any[]>`
    SELECT
      tu.session_id,
      s.name AS session_name,
      s.project_dir,
      SUM(tu.input_tokens) AS input_tokens,
      SUM(tu.output_tokens) AS output_tokens,
      SUM(tu.cache_creation_input_tokens) AS cache_creation_input_tokens,
      SUM(tu.cache_read_input_tokens) AS cache_read_input_tokens,
      SUM(tu.cost_usd) AS cost_usd
    FROM token_usage tu
    LEFT JOIN sessions s ON s.id = tu.session_id
    WHERE tu.user_id = ${userId}
    GROUP BY tu.session_id, s.name, s.project_dir
    ORDER BY cost_usd DESC
    LIMIT ${cap}
  `
  return rows.map((r) => ({
    session_id: r.session_id ?? null,
    session_name: r.session_name ?? null,
    project_dir: r.project_dir ?? null,
    ...rowToTotals(r),
  }))
}

export interface RepoUsageRow extends UsageTotals {
  repo: string
}

/**
 * Per-repo breakdown. Repo key = github_owner/github_repo when present, else
 * the session's project_dir, else 'unknown'.
 */
export async function usageByRepo(userId: string, limit = 50): Promise<RepoUsageRow[]> {
  const cap = Math.min(Math.max(limit, 1), 200)
  const rows = await sql<any[]>`
    SELECT
      COALESCE(
        NULLIF(s.github_owner || '/' || s.github_repo, '/'),
        s.project_dir,
        'unknown'
      ) AS repo,
      SUM(tu.input_tokens) AS input_tokens,
      SUM(tu.output_tokens) AS output_tokens,
      SUM(tu.cache_creation_input_tokens) AS cache_creation_input_tokens,
      SUM(tu.cache_read_input_tokens) AS cache_read_input_tokens,
      SUM(tu.cost_usd) AS cost_usd
    FROM token_usage tu
    LEFT JOIN sessions s ON s.id = tu.session_id
    WHERE tu.user_id = ${userId}
    GROUP BY repo
    ORDER BY cost_usd DESC
    LIMIT ${cap}
  `
  return rows.map((r) => ({ repo: r.repo ?? 'unknown', ...rowToTotals(r) }))
}
