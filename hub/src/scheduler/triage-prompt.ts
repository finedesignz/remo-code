/**
 * Triage prompt template (Phase 06, plan 006).
 *
 * Renders the user-facing prompt that drives `task_kind: 'triage'` runs.
 * The model MUST respond with a single JSON object matching TriageResult
 * (see triage-schema.ts). Caps the log snippet to the last 100 lines.
 *
 * No DB access, no side effects — pure string formatting.
 */

import { fenceUntrusted, SCOPE_CONTRACT } from '../dispatch/untrusted.ts'

export interface RenderTriagePromptInput {
  application_uuid: string
  deployment_uuid: string
  git_repository?: string
  commit_sha?: string
  log_snippet: string
}

export function renderTriagePrompt(input: RenderTriagePromptInput): string {
  const tail = input.log_snippet.split(/\r?\n/).slice(-100).join('\n')

  const repo = input.git_repository ?? '(unknown)'
  const sha = input.commit_sha ?? '(unknown)'

  return [
    'You are a deployment triage assistant. A Coolify deployment failed and you must analyze the build/runtime logs to produce a structured root-cause report.',
    '',
    SCOPE_CONTRACT,
    'ANALYSIS-ONLY: this task makes NO code changes at all — not even a branch or a PR.',
    'Read the logs, output the JSON report below, and change nothing.',
    '',
    // SECURITY: build logs echo attacker-influenced content (dependency names, test
    // output, request paths) and `git_repository` is webhook-supplied. Fence the lot
    // as data — a crafted log line must not be able to close the block and issue
    // instructions (a ``` fence could; `fenceUntrusted` escapes every `<`).
    fenceUntrusted(
      'untrusted_deployment_logs',
      [
        'Deployment context:',
        `- application_uuid: ${input.application_uuid}`,
        `- deployment_uuid: ${input.deployment_uuid}`,
        `- git_repository: ${repo}`,
        `- commit_sha: ${sha}`,
        '',
        'Failure logs (last 100 lines):',
        tail,
      ].join('\n'),
      8000,
    ),
    '',
    'Respond with a SINGLE JSON object — no markdown, no prose, no code fences around it — matching this exact shape:',
    '{',
    '  "error_type": string,                              // short identifier, e.g. "DatabaseConnectionError"',
    '  "severity": "low" | "medium" | "high" | "critical",',
    '  "root_cause": string,                              // 1-3 sentences explaining what went wrong',
    '  "suggested_fix": string,                           // actionable next step',
    '  "confidence": number,                              // 0..1, your confidence in this diagnosis',
    '  "affected_files": string[]                         // OPTIONAL: repo-relative paths likely involved',
    '}',
    '',
    'Do not wrap the JSON in markdown fences. Do not add commentary before or after. Output the JSON object only.',
  ].join('\n')
}
