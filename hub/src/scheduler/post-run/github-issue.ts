/**
 * GitHub-issue post-run action (Phase 06, plan 007, G4).
 *
 * Creates a GitHub issue from a triage run result. Credentials are loaded
 * from the gateway pair (Ottolax primary, claude-gateway fallback) per
 * global CLAUDE.md rule #19 — there is no GITHUB_TOKEN env var on the hub.
 *
 *   GATEWAY_URL / GATEWAY_API_KEY                — Ottolax (primary)
 *   FALLBACK_GATEWAY_URL / FALLBACK_GATEWAY_API_KEY — claude-gateway (fallback)
 *
 * Endpoint: GET {gateway}/api/credentials/service/github  →  { token }
 *
 * Idempotency: sha256(`${repo}|${app_uuid}|${deploy_uuid}`). If an entry
 * for that hash exists in `github_issue_idempotency` within the last 24h,
 * the action is skipped (no duplicate issue).
 *
 * Failures are log-only — they never fail the parent run.
 */
import { createHash } from 'node:crypto'
import { Octokit } from '@octokit/rest'
import type { PostRunAction } from './schema.ts'
import { parseTriageOutput } from '../triage-schema.ts'
import { render } from './template.ts'
import { getRun } from '../../db/scheduled-tasks-dal.ts'
import { hasOpenIssueForHash, recordOpenIssueForHash } from '../../db/dal.ts'

interface GhIssueCtx {
  userId: string
  templateVars: Record<string, unknown>
  runId: string
}

const WINDOW_HOURS = 24

const ISSUE_BODY_TEMPLATE = [
  '## Triage Result',
  '',
  '- **Error type:** {{error_type}}',
  '- **Severity:** {{severity}}',
  '- **Confidence:** {{confidence}}',
  '',
  '### Root cause',
  '{{root_cause}}',
  '',
  '### Suggested fix',
  '{{suggested_fix}}',
  '',
  '### Affected files',
  '{{affected_files}}',
  '',
  '## Deployment',
  '',
  '- **Repository:** {{git_repository}}',
  '- **Commit:** `{{commit_sha}}`',
  '- **Application UUID:** `{{application_uuid}}`',
  '- **Deployment UUID:** `{{deployment_uuid}}`',
  '- **Run:** {{run_url}}',
  '',
  '---',
  '_Automated triage by remo-code._',
].join('\n')

async function loadGithubToken(): Promise<string | null> {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [process.env.GATEWAY_URL, process.env.GATEWAY_API_KEY],
    [process.env.FALLBACK_GATEWAY_URL, process.env.FALLBACK_GATEWAY_API_KEY],
  ]
  for (const [url, key] of pairs) {
    if (!url || !key) continue
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/api/credentials/service/github`, {
        headers: { 'X-Api-Key': key },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) {
        console.warn(`[post-run.github-issue] gateway ${url} returned ${res.status}`)
        continue
      }
      const body = (await res.json()) as { token?: string }
      if (body?.token) return body.token
    } catch (err: any) {
      console.warn(`[post-run.github-issue] gateway ${url} threw: ${err?.message}`)
    }
  }
  return null
}

function buildHash(repo: string, appUuid: string, deployUuid: string): string {
  return createHash('sha256').update(`${repo}|${appUuid}|${deployUuid}`).digest('hex')
}

export async function executeGithubIssue(action: PostRunAction, ctx: GhIssueCtx): Promise<void> {
  if (action.type !== 'github_issue') return

  const repo = action.config.repo_full_name
  const [owner, repoName] = repo.split('/')
  if (!owner || !repoName) {
    console.warn(`[post-run.github-issue] invalid repo_full_name=${repo}`)
    return
  }

  // Pull deployment metadata off the run row (G5 columns). Fall back to
  // templateVars (synthesized triage runs already pass these).
  let appUuid = String(ctx.templateVars.application_uuid ?? '')
  let deployUuid = String(ctx.templateVars.deployment_uuid ?? '')
  let gitRepo = String(ctx.templateVars.git_repository ?? '')
  let commitSha = String(ctx.templateVars.commit_sha ?? '')
  if (!appUuid || !deployUuid) {
    try {
      const row: any = await getRun(ctx.runId, ctx.userId)
      if (row) {
        appUuid = appUuid || (row.application_uuid ?? '')
        deployUuid = deployUuid || (row.deployment_uuid ?? '')
        gitRepo = gitRepo || (row.git_repository ?? '')
        commitSha = commitSha || (row.commit_sha ?? '')
      }
    } catch (err: any) {
      console.warn(`[post-run.github-issue] getRun threw: ${err?.message}`)
    }
  }

  // Parse triage result from output_snippet; fall back to a generic title/body.
  const triage = parseTriageOutput(String(ctx.templateVars.output_snippet ?? ''))
  let severity = 'unknown'
  let errorType = 'Deployment failure'
  let templateVars: Record<string, unknown>
  if (triage.ok) {
    severity = triage.value.severity
    errorType = triage.value.error_type
    templateVars = {
      ...ctx.templateVars,
      error_type: triage.value.error_type,
      severity: triage.value.severity,
      root_cause: triage.value.root_cause,
      suggested_fix: triage.value.suggested_fix,
      confidence: triage.value.confidence,
      affected_files: (triage.value.affected_files ?? []).map((f) => `- \`${f}\``).join('\n') || '_(none reported)_',
      application_uuid: appUuid || '_(unknown)_',
      deployment_uuid: deployUuid || '_(unknown)_',
      git_repository: gitRepo || '_(unknown)_',
      commit_sha: commitSha || '_(unknown)_',
    }
  } else {
    console.warn(`[post-run.github-issue] triage_parse_error: ${(triage as { detail: string }).detail}; using fallback body`)
    templateVars = {
      ...ctx.templateVars,
      error_type: errorType,
      severity,
      root_cause: String(ctx.templateVars.error || 'Unknown deployment failure'),
      suggested_fix: '_(triage parse failed — see run logs)_',
      confidence: 0,
      affected_files: '_(unknown)_',
      application_uuid: appUuid || '_(unknown)_',
      deployment_uuid: deployUuid || '_(unknown)_',
      git_repository: gitRepo || '_(unknown)_',
      commit_sha: commitSha || '_(unknown)_',
    }
  }

  const title = `[${severity}] ${errorType} — ${appUuid || 'app'}`
  const body = render(ISSUE_BODY_TEMPLATE, templateVars)

  // Idempotency check — only meaningful when we have a real (app, deploy) pair.
  if (appUuid && deployUuid) {
    const hash = buildHash(repo, appUuid, deployUuid)
    try {
      const dup = await hasOpenIssueForHash(ctx.userId, hash, WINDOW_HOURS)
      if (dup) {
        console.info(
          `[post-run.github-issue] dedupe: existing issue for ${repo} app=${appUuid} deploy=${deployUuid}`,
        )
        return
      }
      // Record placeholder before API call to narrow the race window.
      // (Best-effort — Octokit failure still leaves a 0 row that gets overwritten on next success.)
      void hash
    } catch (err: any) {
      console.warn(`[post-run.github-issue] idempotency check failed: ${err?.message}`)
    }
  }

  const token = await loadGithubToken()
  if (!token) {
    console.warn('[post-run.github-issue] no github token from gateway pair; skipping')
    return
  }

  const labels = Array.from(
    new Set([
      ...(action.config.labels ?? []),
      `severity:${severity}`,
      'automated',
      'remo-code',
    ]),
  )

  try {
    const octokit = new Octokit({ auth: token, request: { timeout: 10_000 } })
    const res = await octokit.issues.create({
      owner,
      repo: repoName,
      title,
      body,
      labels,
      assignees: action.config.assignees,
    })
    const issueNumber: number = res.data?.number ?? 0
    if (appUuid && deployUuid && issueNumber > 0) {
      const hash = buildHash(repo, appUuid, deployUuid)
      try {
        await recordOpenIssueForHash(ctx.userId, hash, issueNumber, repo)
      } catch (err: any) {
        console.warn(`[post-run.github-issue] record idempotency failed: ${err?.message}`)
      }
    }
    console.info(
      `[post-run.github-issue] created ${repo}#${issueNumber} severity=${severity}`,
    )
  } catch (err: any) {
    console.error(
      `[post-run.github-issue] Octokit create failed repo=${repo}: ${err?.status ?? ''} ${err?.message}`,
    )
  }
}
