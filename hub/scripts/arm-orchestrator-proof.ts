/**
 * PTYCAP-05-07 -- operator one-shot: ARM, ENABLE or DISARM the throwaway-repo due->PR proof.
 *
 * DATA ONLY. This script never flips a REMO_* flag, never sets a token cap, and never reaches
 * a hosting provider. It creates (in ONE transaction under a per-user advisory lock) the
 * exactly-one autospawn allowlist entry, the DISABLED proof task, its due-scan row and the
 * frozen proof run. The owner then sets the hub flags by hand, redeploys, verifies the hub is
 * idle, and only then runs --enable (the owner's final act).
 *
 * The budgets (max injects / tokens / wall ms) are read HERE, at arm time, from these flags or
 * REMO_PROOF_MAX_INJECTS / REMO_PROOF_MAX_TOKENS / REMO_PROOF_MAX_WALL_MS, and are FROZEN into
 * the proof run: a later environment change cannot widen a running proof. Garbage refuses.
 *
 * Rule 6 note: --disarm removes exactly ONE configuration row (the allowlist entry matching the
 * armed run's exact user_id and repo_ident) inside the disarm transaction. There is no bare
 * delete, no table-wide operation, and nothing is ever dropped or reset.
 *
 * Usage:
 *   bun run hub/scripts/arm-orchestrator-proof.ts \
 *     --user <userId> --session <sessionId> --repo-ident github://owner/repo \
 *     --installation-id <id> [--agent-login <login>] \
 *     [--max-injects N --max-tokens N --max-wall-ms N] [--every N --unit minutes|hours] \
 *     [--dry-run | --enable | --disarm]
 *
 *   --dry-run   every read-only precondition, prints the summary, zero writes
 *   (default)   arm
 *   --enable    owner's final act: switch the armed task on (needs only --user)
 *   --disarm    transactional disarm, then best-effort session kill switch (needs only --user)
 *
 * Requires DATABASE_URL. Exit codes: 0 ok, 1 unexpected error, 2 bad arguments or a refusal.
 */

const TAG = '[arm-orchestrator-proof]';
const argv = process.argv.slice(2);

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}
const has = (name: string) => argv.includes(`--${name}`);

const USAGE =
  'usage: arm-orchestrator-proof --user <id> --session <id> --repo-ident github://owner/repo --installation-id <n>\n' +
  '         [--agent-login <login>] [--max-injects N] [--max-tokens N] [--max-wall-ms N]\n' +
  '         [--every N --unit minutes|hours] [--dry-run | --enable | --disarm]\n' +
  '       --enable and --disarm need only --user.';

function fail(msg: string): never {
  console.error(`${TAG} ERROR: ${msg}`);
  console.error(USAGE);
  process.exit(2);
}

function printSummary(s: any): void {
  console.log(`${TAG} summary:`);
  console.log(`  repo_ident        = ${s.repoIdent}  (installation ${s.installationId}, session ${s.sessionId})`);
  console.log(`  default branch    = ${s.defaultBranch}  base_sha = ${s.baseSha}`);
  console.log(`  proof branch      = ${s.branchPreview}`);
  console.log(`  FROZEN budget     = ${s.budget.maxInjects} injects / ${s.budget.maxTokens} tokens / ${s.budget.maxWallMs} ms wall`);
  console.log(`  cadence           = every ${s.schedule.interval} ${s.schedule.unit}`);
  console.log(`  protection        = ${s.protectionShape}  rulesets ${JSON.stringify(s.rulesetIds)}  digest ${s.digestPrefix}...`);
  console.log(`  required contexts = ${JSON.stringify(s.requiredContexts)}`);
  console.log(`  allowlist now     = ${JSON.stringify(s.allowlist)}`);
  console.log(`  bypass actors     = ${s.bypassVerification}   agent permission = ${s.agentPermission}`);
  if (s.runId) console.log(`  run ${s.runId}  task ${s.taskId}  branch ${s.branch}`);
  for (const w of s.warnings) console.log(`  ${w}`);
}

async function main(): Promise<number> {
  const mode = (['dry-run', 'enable', 'disarm'] as const).filter((m) => has(m));
  if (mode.length > 1) fail(`choose at most one of --dry-run, --enable, --disarm (got ${mode.join(', ')})`);

  const userId = arg('user');
  if (!userId) fail('--user <userId> is required');

  const armMode = mode.length === 0 || mode[0] === 'dry-run';
  let sessionId: string | undefined;
  let repoIdent: string | undefined;
  let installationId = 0;
  if (armMode) {
    sessionId = arg('session');
    repoIdent = arg('repo-ident');
    const rawInstall = arg('installation-id');
    if (!sessionId) fail('--session <sessionId> is required');
    if (!repoIdent) fail('--repo-ident github://owner/repo is required');
    if (!rawInstall || !/^[0-9]+$/.test(rawInstall) || Number(rawInstall) <= 0) fail('--installation-id must be a positive integer');
    installationId = Number(rawInstall);
  }

  // The DAL (and its connection) is imported only after this gate, so a refusal mutates nothing.
  if (!process.env.DATABASE_URL) {
    fail('no DATABASE_URL set - refusing to run (export DATABASE_URL and retry; REMO_E2E_DB_URL is not honoured).');
  }

  if (mode[0] === 'disarm') {
    const { disarmProof } = await import('../src/orchestrator/proof-arm.ts');
    const { disarmProofRunTx } = await import('../src/db/orchestrator-proof-dal.ts');
    const { engageKillSwitch } = await import('../src/dispatch/automation-controls.ts');
    const r = await disarmProof({ userId: userId!, detail: 'disarmed by owner via arm-orchestrator-proof' }, { disarmTx: disarmProofRunTx, engageKillSwitch });
    if (!r.disarmed) {
      console.log(`${TAG} nothing to disarm (no armed or running proof for this user).`);
      return 0;
    }
    console.log(`${TAG} disarmed run ${r.run.id} (${r.run.repo_ident}): task + proof row disabled, allowlist entry removed.`);
    if (r.killSwitch.engaged) console.log(`${TAG} session kill switch engaged for session ${r.run.session_id}.`);
    else console.error(`${TAG} WARNING: the disarm stands but the session kill switch FAILED: ${r.killSwitch.error}. Engage it by hand.`);
    console.log('Remaining OWNER step (not done here): unset the hub flags named in the PTYCAP-05 runbook, then redeploy the hub.');
    return 0;
  }

  if (mode[0] === 'enable') {
    const { enableProof } = await import('../src/orchestrator/proof-arm.ts');
    const { enableProofTaskTx } = await import('../src/db/orchestrator-proof-dal.ts');
    const r = await enableProof({ userId: userId! }, { enableTx: enableProofTaskTx });
    if (!r.ok) {
      console.error(`${TAG} REFUSED: ${r.code} - ${r.detail}`);
      return 2;
    }
    console.log(`${TAG} ${r.message}`);
    return 0;
  }

  const { armProof } = await import('../src/orchestrator/proof-arm.ts');
  const { isGitHubAppConfigured, listInstallationRepos } = await import('../src/auth/github-app.ts');
  const { makeProofGithub } = await import('../src/orchestrator/proof-github.ts');
  const { armProofRunTx } = await import('../src/db/orchestrator-proof-dal.ts');
  const { getGithubInstallationForUser, getSessionRepoBinding } = await import('../src/db/orchestrator-proof-arm-reads.ts');
  const { listRepoAutospawnAllowlist } = await import('../src/db/orchestrator-rows-dal.ts');

  const r = await armProof(
    {
      userId: userId!,
      sessionId: sessionId!,
      repoIdent: repoIdent!,
      installationId,
      agentLogin: arg('agent-login'),
      maxInjects: arg('max-injects'),
      maxTokens: arg('max-tokens'),
      maxWallMs: arg('max-wall-ms'),
      every: arg('every'),
      unit: arg('unit'),
      dryRun: has('dry-run'),
    },
    {
      isGithubAppConfigured: isGitHubAppConfigured,
      makeGithub: (id) => makeProofGithub({ installationId: id }),
      getInstallation: (uid, id) => getGithubInstallationForUser(uid, id),
      listInstallationRepos,
      getSession: getSessionRepoBinding,
      listAllowlist: listRepoAutospawnAllowlist,
      armTx: armProofRunTx,
      env: process.env,
      now: () => new Date(),
    },
  );

  if (!r.ok) {
    console.error(`${TAG} REFUSED: ${r.code} - ${r.detail}`);
    return 2;
  }
  printSummary(r.summary);
  if (r.dryRun) {
    console.log(`${TAG} DRY-RUN - no writes performed. Re-run without --dry-run to arm.`);
    return 0;
  }
  console.log('');
  console.log(`${TAG} ARMED (task is DISABLED). Remaining OWNER steps - NOT done by this script:`);
  console.log('  1. Set the hub flags and the daily token cap named in the PTYCAP-05 runbook.');
  console.log('  2. Redeploy the hub so the flags take effect, then verify it is idle.');
  console.log(`  3. Enable the proof:  bun run hub/scripts/arm-orchestrator-proof.ts --user ${userId} --enable`);
  console.log(`  Roll back any time:   bun run hub/scripts/arm-orchestrator-proof.ts --user ${userId} --disarm`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${TAG} FAILED:`, err?.message ?? err);
    process.exit(1);
  });
