/**
 * THE HUB PUBLISHES (milestone WORK). The single code path that can put an
 * email-originated change on a live client site — and the single code path that can
 * write `work_runs.published = true`.
 *
 * FOUR CONDITIONS, ALL HUB-OBSERVED, ALL REQUIRED:
 *   1. `site.auto_publish === true`            (operator trust flag, DEFAULT FALSE)
 *   2. `hubQc.diff_scope.ok`                   (branch touches ONLY site_dir — hub-checked diff)
 *   3. `hubQc.build.ok`                        (hub ran the operator's build; real exit code)
 *   4. `hubQc.probe.ok`                        (hub fetched the URL itself; real 2xx)
 * Anything else ⇒ NO deploy call is made at all. The agent's opinion is not an input:
 * nothing it can say appears in this function's signature.
 *
 * Publish = `work_publish` on the supervisor (ff-only merge of `work/<id>` into the
 * default branch + the operator's `publish_cmd`) followed by the Coolify redeploy
 * (same client the orchestrator verify-tail uses), then a POST-publish re-probe. A
 * failing re-probe is recorded LOUDLY (`deploy_status: 'live_probe_failed'`) with the
 * revert command, because at that point the client's site really is changed.
 */
import { runSupervisorReadCommand, parseSnippet } from '../ext/supervisor-read.ts'
import { coolifyConfigFromEnv, triggerRedeploy } from '../lib/coolify-client.ts'
import type { HubQc } from './verify.ts'
import type { WorkSite } from '../db/work-dal.ts'

export interface PublishInput {
  supervisorId: string
  userId: string
  projectDir: string
  branch: string
  site: WorkSite
  qc: HubQc
}

export interface PublishOutcome {
  published: boolean
  /** not_permitted | qc_failed | merge_failed | deploy_failed | live_probe_failed | published */
  deploy_status: string
  merged_sha: string | null
  live_url: string | null
  live_status: number | null
  revert_command: string | null
  error?: string
}

export interface PublishDeps {
  runCommand: typeof runSupervisorReadCommand
  fetchUrl: (url: string) => Promise<{ status: number }>
  redeploy: (uuid: string) => Promise<{ ok: boolean; error?: string }>
}

const REAL_DEPS: PublishDeps = {
  runCommand: runSupervisorReadCommand,
  fetchUrl: async (url) => ({ status: (await fetch(url, { redirect: 'follow' })).status }),
  redeploy: async (uuid) => {
    const cfg = coolifyConfigFromEnv()
    if (!cfg) return { ok: false, error: 'no_coolify_config' }
    const r = await triggerRedeploy(cfg, uuid)
    return { ok: !!r.ok, error: (r as any).error }
  },
}

/**
 * TRUE iff every publish precondition holds. Pure + exported so the tests can pin it:
 * a change to the publish rule that forgets one condition fails a test, not a client site.
 */
export function mayPublish(site: WorkSite, qc: HubQc): boolean {
  return (
    site.auto_publish === true &&
    qc.diff_scope.ok === true &&
    qc.build.ok === true &&
    qc.probe.ok === true &&
    qc.ok === true
  )
}

/** Never throws. Makes NO deploy call unless `mayPublish` holds. */
export async function publishWork(
  i: PublishInput,
  deps?: Partial<PublishDeps>,
): Promise<PublishOutcome> {
  const d: PublishDeps = { ...REAL_DEPS, ...deps }
  const base: PublishOutcome = {
    published: false,
    deploy_status: 'not_published',
    merged_sha: null,
    live_url: null,
    live_status: null,
    revert_command: null,
  }

  if (!i.site.auto_publish) return { ...base, deploy_status: 'not_permitted' }
  if (!mayPublish(i.site, i.qc)) {
    return { ...base, deploy_status: 'qc_failed', error: i.qc.failure ?? 'qc_incomplete' }
  }

  // The EXACT SHA the hub's QC verified. work_publish merges THIS sha (not a re-fetched
  // origin/<branch>) and aborts if origin/<branch> has moved since QC (P0 #1, TOCTOU).
  const verifiedSha = i.qc.diff_scope.head_sha
  if (!verifiedSha) {
    return { ...base, deploy_status: 'qc_failed', error: 'no_verified_sha' }
  }

  // 1) ff-only merge of the verified SHA into the default branch + the operator publish_cmd.
  const mergeRes = await d.runCommand(
    i.supervisorId,
    i.userId,
    'work_publish' as any,
    [i.projectDir, i.branch, i.site.default_branch ?? 'main', verifiedSha, i.site.publish_cmd ?? ''],
    15 * 60_000,
  )
  const merged = parseSnippet<{
    merged_sha: string
    publish_exit_code: number
    publish_output: string
  }>(mergeRes)
  if (!merged) {
    const err = mergeRes.error ?? 'merge_failed'
    // The supervisor aborted because origin/<branch> moved after QC — surface it distinctly.
    const status = err.includes('branch_moved_after_qc') ? 'branch_moved_after_qc' : 'merge_failed'
    return { ...base, deploy_status: status, error: err }
  }
  if (merged.publish_exit_code !== 0) {
    return {
      ...base,
      deploy_status: 'deploy_failed',
      merged_sha: merged.merged_sha,
      error: `publish_cmd_exit_${merged.publish_exit_code}`,
      revert_command: revertCommand(i, merged.merged_sha),
    }
  }

  // 2) Coolify redeploy (when the site is a Coolify app).
  if (i.site.coolify_app_uuid) {
    const r = await d.redeploy(i.site.coolify_app_uuid)
    if (!r.ok) {
      return {
        ...base,
        deploy_status: 'deploy_failed',
        merged_sha: merged.merged_sha,
        error: r.error ?? 'redeploy_failed',
        revert_command: revertCommand(i, merged.merged_sha),
      }
    }
  }

  // 3) POST-publish re-probe of the LIVE url. The change is already out; a failure here
  //    is recorded loudly with the revert command rather than swallowed.
  let liveStatus: number | null = null
  const liveUrl = i.site.verify_url?.trim() || null
  if (liveUrl) {
    try {
      liveStatus = (await d.fetchUrl(liveUrl)).status
    } catch {
      liveStatus = 0
    }
    if (!(liveStatus >= 200 && liveStatus < 300)) {
      return {
        published: true, // it IS live — lying about that would be the dangerous direction
        deploy_status: 'live_probe_failed',
        merged_sha: merged.merged_sha,
        live_url: liveUrl,
        live_status: liveStatus,
        revert_command: revertCommand(i, merged.merged_sha),
        error: `live_probe_${liveStatus}`,
      }
    }
  }

  return {
    published: true,
    deploy_status: 'published',
    merged_sha: merged.merged_sha,
    live_url: liveUrl,
    live_status: liveStatus,
    revert_command: revertCommand(i, merged.merged_sha),
  }
}

function revertCommand(i: PublishInput, sha: string): string {
  const publish = i.site.publish_cmd ? ` && ${i.site.publish_cmd}` : ''
  return `git -C <repo> revert --no-edit ${sha} && git push origin ${i.site.default_branch ?? 'main'}${publish}`
}
