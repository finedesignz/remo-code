// hub/src/corch/prompt.ts
//
// CORCH-01 (CORCH-R1.12): the server-owned prompt template. Everything an outside party can influence
// (title, body, source, source_ref) goes ONLY through fenceUntrusted. The template itself never
// instructs a merge, a push to the default branch, or a deploy; it states the prohibition once.

import { fenceUntrusted, SCOPE_CONTRACT } from '../dispatch/untrusted.ts'
import { corchBranch } from './keys.ts'
import type { CorchProject, CorchWorkItem } from './store.ts'

export const CORCH_PROHIBITION = 'Never merge any pull request, never push to the default branch, never deploy.'

export function buildCorchPrompt(a: {
  item: Pick<CorchWorkItem, 'id' | 'title' | 'body' | 'source' | 'source_ref'>
  project: Pick<CorchProject, 'repo_ident'>
  worktreePath: string | null
}): string {
  const where = a.worktreePath ? `the worktree at ${a.worktreePath}` : 'the repository worktree assigned to this session'
  return [
    `CORCH work item ${a.item.id} for ${a.project.repo_ident}.`,
    '',
    SCOPE_CONTRACT,
    '',
    `Work only in ${where} on branch ${corchBranch(a.item.id)}, as one GSD phase. ` +
      'When it is done, push that branch and open a pull request.',
    CORCH_PROHIBITION,
    '',
    fenceUntrusted('untrusted_title', a.item.title),
    fenceUntrusted('untrusted_body', a.item.body),
    fenceUntrusted('untrusted_source', a.item.source),
    fenceUntrusted('untrusted_source_ref', a.item.source_ref),
  ].join('\n')
}
