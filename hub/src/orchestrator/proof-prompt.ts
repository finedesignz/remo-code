// hub/src/orchestrator/proof-prompt.ts
// PTYCAP-05 (D-11): the proof prompt, rendered ONLY from the claimed (running)
// proof-run snapshot. It REPLACES the dev macro for a proof tick; macro_task_type
// stays 'dev' and nothing falls back to the dev macro.
//
// The prompt is ADVISORY (F1): the enforced boundary is the GitHub ruleset on the
// default branch plus the hub-side detective checks, not these words. It therefore
// says nothing about hub gating, and it deliberately avoids the vocabulary of
// shipping (the unit test greps the FINAL string for the banned tokens).

import type { ProofRun } from './proof-types.ts';

export function renderProofPrompt(run: ProofRun): string {
  if (run.status !== 'running') {
    throw new Error(`renderProofPrompt: run ${run.id} is '${run.status}', expected 'running'`);
  }
  const file = `docs/proof-${run.id}.md`;
  return [
    `You are running a small, bounded proof task on the throwaway repository ${run.repo_ident}.`,
    '',
    `STEP 0 - boundaries. The branch \`${run.default_branch}\` is read-only for you: never commit to it and never push to it.`,
    `Your only working branch is \`${run.branch}\`. Create it from \`${run.default_branch}\` if it does not exist, and push only that exact branch.`,
    '',
    'STEP 1 - one trivially safe change. Create (or edit) exactly one markdown file:',
    `  ${file}`,
    `Put one short sentence in it. Touch no other file. Commit it on \`${run.branch}\`.`,
    '',
    `STEP 2 - push \`${run.branch}\` and open a pull request from it against \`${run.default_branch}\`.`,
    '',
    'STEP 3 - wait for the pull request checks to finish. If a check is red, you may fix it by committing to the same branch only; otherwise leave the pull request alone.',
    '',
    'STEP 4 - report and STOP. End your reply with a STATE block, then stop. Do not start any other work, and do not touch any other repository or branch.',
    '<<STATE',
    'lifecycle: development',
    'last_action: opened pull request <PR URL>',
    'next_action: none',
    'STATE>>',
    '',
    'If you cannot or should not do this task, do not improvise. Reply with a STATE block whose last_action starts with the word nothing, followed by a short reason, then stop:',
    '<<STATE',
    'last_action: nothing - <reason>',
    'STATE>>',
  ].join('\n');
}
