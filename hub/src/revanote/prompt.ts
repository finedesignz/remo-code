/**
 * Revanote agent-prompt + storage-prefix builder.
 *
 * - `previewComment` slices the comment to 30 grapheme clusters using
 *   `Intl.Segmenter` (emoji-safe). The output is the violet-pill label in
 *   the web `MessageBubble`.
 * - `storagePrefix` is the line stored on `messages.content` so the web UI
 *   can detect a revanote-originated user_message and render the pill.
 *   Mirrors the scheduler's `[scheduled: <task name>]` shape.
 * - `renderAnnotationPrompt` is the natural-language prompt sent to Claude.
 *   It is intentionally explicit about the envelope contract so the model
 *   reliably emits `<<JSON>>...<<END>>` at the end of its reply.
 */
import type { AnnotationRow, RevanoteMapping } from '../db/revanote-dal.ts'
import { fenceUntrusted, SCOPE_CONTRACT } from '../dispatch/untrusted.ts'

export function previewComment(comment: string, max = 30): string {
  const trimmed = (comment ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return ''
  // Prefer Intl.Segmenter for grapheme-cluster splitting. Falls back to
  // codepoint iteration if Segmenter is unavailable (older Bun, or limit/test
  // environments — extremely unlikely on Bun 1.x but cheap to be safe).
  try {
    if (typeof (Intl as any).Segmenter === 'function') {
      const seg = new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' })
      const parts: string[] = []
      for (const s of seg.segment(trimmed) as Iterable<{ segment: string }>) {
        parts.push(s.segment)
        if (parts.length >= max) break
      }
      let out = parts.join('')
      if (parts.length >= max && trimmed.length > out.length) out += '…'
      return out
    }
  } catch {}
  // Codepoint fallback.
  const cps = Array.from(trimmed)
  if (cps.length <= max) return cps.join('')
  return cps.slice(0, max).join('') + '…'
}

export function storagePrefix(comment: string): string {
  return `[revanote: ${previewComment(comment)}]`
}

interface PromptOpts {
  annotation: AnnotationRow
  mapping: RevanoteMapping | null
}

export function renderAnnotationPrompt(opts: PromptOpts): string {
  const { annotation: a, mapping: m } = opts
  const replies = Array.isArray(a.replies_json) ? a.replies_json : []
  const repliesText = replies.length
    ? replies
        .map((r: any, i: number) =>
          `  ${i + 1}. ${r.author ?? 'reviewer'}: ${(r.text ?? '').toString().slice(0, 500)}`,
        )
        .join('\n')
    : '  (none)'

  // SECURITY: an annotation body is webhook-derived, untrusted prose. `direct`
  // (commit straight to main) and `auto_merge` (squash-merge without review) stay
  // POSSIBLE, but only for a mapping the owner has explicitly marked `trusted`.
  // Untrusted mapping ⇒ propose-only (PR, human merges), whatever the payload says.
  const trusted = m?.trusted === true
  const deployStrategy = trusted ? (m?.deploy_strategy ?? 'pr') : 'pr'
  const repoPath = m?.repo_path ?? '(no mapping configured for this host — fix in-tree only)'
  const autoMerge = trusted && m?.auto_merge === true
  const branch = `revanote/annotation-${a.annotation_id_external}`

  const strategyInstructions =
    deployStrategy === 'pr'
      ? `- Strategy: PR.\n` +
        `- Create branch \`${branch}\`, commit fix with a descriptive message, push, then \`gh pr create\` with the annotation comment in the body.\n` +
        (autoMerge
          ? `- auto_merge=true → \`gh pr merge <N> --squash --delete-branch\` immediately after CI passes.\n`
          : `- Leave the PR open for human review.\n`)
      : deployStrategy === 'direct'
        ? `- Strategy: DIRECT.\n` +
          `- Commit fix on main, push directly. Coolify will auto-deploy.\n`
        : `- Strategy: NONE.\n` +
          `- Edit only. Do NOT git push. The reviewer will check the diff locally.\n`

  const elementMeta = (a.payload_raw as any)?.element_meta ?? null
  const viewport = (a.payload_raw as any)?.capture_viewport ?? null
  const fixContract = (a.payload_raw as any)?.fix_contract ?? null
  const extraContext = [
    elementMeta ? `Element meta: ${JSON.stringify(elementMeta).slice(0, 800)}` : null,
    viewport ? `Capture viewport: ${JSON.stringify(viewport).slice(0, 400)}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  const annotationUrl = a.annotation_url
    ? `Annotation deep-link: ${a.annotation_url}\n`
    : ''

  // Everything reviewer-authored (comment, replies, element_meta, selector) is
  // untrusted webhook input → one fenced DATA block.
  const untrusted = [
    `Page: ${a.page_url}`,
    annotationUrl ? annotationUrl.trimEnd() : null,
    a.element_selector ? `Element: ${a.element_selector}` : null,
    a.x !== null && a.y !== null ? `Click position: (${a.x}, ${a.y})` : null,
    a.screenshot_url ? `Screenshot: ${a.screenshot_url}` : null,
    extraContext || null,
    ``,
    `Reviewer's comment:`,
    a.comment,
    ``,
    `Replies/thread:`,
    repliesText,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join('\n')

  // Phase 5 — best-guess-default fix contract. Only rendered when the
  // dispatch payload carries a `fix_contract` block; absent ⇒ these arrays
  // are empty and the rendered prompt is byte-identical to pre-Phase-5.
  const fixContractInstructions = fixContract
    ? [
        `Fix contract: attempt a reasonable best-guess default and mark the fix`,
        `resolved rather than asking, whenever the comment is resolvable.`,
        `Carve-out: this default does NOT apply to destructive or`,
        `high-blast-radius changes — deleting or overwriting real content,`,
        `force-pushing, or anything that loses data still warrants a question`,
        `even under best-guess-default.`,
        `"needs_clarification": true is honored ONLY when paired with a`,
        `"clarification_reason" from exactly these four values:`,
        `ambiguous_intent, conflicting_instruction, missing_target, out_of_scope.`,
        `Citing one of these to avoid doing resolvable work is a contract`,
        `violation — the reason code does not excuse it.`,
      ]
    : []
  const assumptionEnvelopeLine = fixContract
    ? [`  "assumption": "one sentence describing the default you chose, when resolved without asking",`]
    : []
  const clarificationReasonEnvelopeLine = fixContract
    ? [
        `  "clarification_reason": "one of: ambiguous_intent | conflicting_instruction | missing_target | out_of_scope (required when needs_clarification is true)",`,
      ]
    : []

  return [
    `A reviewer left a Revanote annotation on a deployed page. Please address it.`,
    ``,
    `Repo: ${repoPath}`,
    ``,
    SCOPE_CONTRACT,
    trusted
      ? `NOTE: this mapping is operator-TRUSTED — the Deploy plan below overrides rule 4.`
      : null,
    ``,
    ...fixContractInstructions,
    fixContract ? `` : null,
    fenceUntrusted('untrusted_annotation', untrusted),
    ``,
    `Deploy plan:`,
    strategyInstructions,
    ``,
    `This is a single Revanote comment dispatched on its own (no sibling`,
    `comments were batched with it). Before marking it resolved:`,
    `  1. Make the fix in its own branch, commit, push, and open its own PR.`,
    `  2. Wait for CI to go green.`,
    `  3. Merge the PR yourself.`,
    `  4. Redeploy the site that serves the page_url host.`,
    `  5. Re-fetch this comment's page_url to confirm the change is actually`,
    `     live.`,
    `Only after all five steps is this comment eligible for "resolved": true. Cite`,
    `the MERGED commit SHA on the repo's default branch as "commit_sha" — not`,
    `your local working-tree or unmerged branch-tip SHA — and the confirmed`,
    `live URL as "deploy_url". Never set "resolved": true before the merge and`,
    `the deploy have both actually happened. Any comment you cannot verify this`,
    `way gets "resolved": false or "needs_clarification": true with the`,
    `reason — never a guess. This is advisory text — the hub independently`,
    `verifies "commit_sha" against the GitHub remote before trusting`,
    `"resolved": true (a merged commit on the default branch passes; an`,
    `unmerged/local one does not), and downgrades to false with a reason`,
    `otherwise.`,
    ``,
    `When you are done (resolved OR clarification needed), end your reply with a`,
    `machine-readable JSON envelope so the hub can post a callback. Use exactly`,
    `this format on its own lines (no markdown fences inside the envelope):`,
    ``,
    `<<JSON>>`,
    `{`,
    `  "resolved": true,`,
    `  "action_taken": "short summary of what you did",`,
    ...assumptionEnvelopeLine,
    `  "files_changed": ["path/one.tsx", "path/two.ts"],`,
    `  "commit_sha": "the full commit SHA MERGED to the default branch that made this fix (required when resolved is true)",`,
    `  "deployed": true,`,
    `  "deploy_url": "the live URL you re-fetched to confirm the change, when deployed is true",`,
    ...clarificationReasonEnvelopeLine,
    `  "needs_clarification": false`,
    `}`,
    `<<END>>`,
    ``,
    `If you cannot fix it autonomously, set "resolved": false, "needs_clarification": true,`,
    fixContract
      ? `and set "clarification_reason" to one of the four values above, and put a single`
      : `and put a single question in "clarification_question".`,
    fixContract ? `question in "clarification_question".` : null,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n')
}

interface BatchPromptItem {
  annotation: AnnotationRow
  mapping: RevanoteMapping | null
}

/**
 * Batch prompt (feat/revanote-batch-dispatch): one turn covering every
 * annotation that shares a `batch_id` and landed on the same target session
 * within the debounce window. Each annotation's reviewer-authored content is
 * fenced separately (still untrusted webhook input per-item), tagged with its
 * EXTERNAL annotation id so the reply's `annotations[]` array can be routed
 * back unambiguously (`result-schema.ts` `RevanoteBatchResult`).
 *
 * Deploy trust/strategy is taken from the FIRST item's mapping — batch members
 * are grouped by the same resolved target session, which in practice means the
 * same repo mapping, so this mirrors `renderAnnotationPrompt`'s per-mapping
 * trust gate without re-deriving it per item.
 */
export function renderBatchAnnotationPrompt(opts: { items: BatchPromptItem[] }): string {
  const { items } = opts
  const first = items[0]
  const trusted = first?.mapping?.trusted === true
  const deployStrategy = trusted ? (first?.mapping?.deploy_strategy ?? 'pr') : 'pr'
  const repoPath = first?.mapping?.repo_path ?? '(no mapping configured for this host — fix in-tree only)'
  const autoMerge = trusted && first?.mapping?.auto_merge === true

  const strategyInstructions =
    deployStrategy === 'pr'
      ? `- Strategy: PR.\n` +
        `- Create ONE branch \`revanote/batch-${items.map((i) => i.annotation.annotation_id_external).join('-').slice(0, 60)}\`,\n` +
        `  commit the fixes for every comment below onto it, push, then \`gh pr create\`\n` +
        `  listing every comment addressed in the body.\n` +
        (autoMerge
          ? `- auto_merge=true → \`gh pr merge <N> --squash --delete-branch\` immediately after CI passes.\n`
          : `- Leave the PR open for human review.\n`)
      : deployStrategy === 'direct'
        ? `- Strategy: DIRECT.\n` +
          `- Commit every fix on main, push directly. Coolify will auto-deploy.\n`
        : `- Strategy: NONE.\n` +
          `- Edit only. Do NOT git push. The reviewer will check the diff locally.\n`

  const fencedItems = items
    .map(({ annotation: a }) => {
      const replies = Array.isArray(a.replies_json) ? a.replies_json : []
      const repliesText = replies.length
        ? replies
            .map((r: any, i: number) => `  ${i + 1}. ${r.author ?? 'reviewer'}: ${(r.text ?? '').toString().slice(0, 500)}`)
            .join('\n')
        : '  (none)'
      const elementMeta = (a.payload_raw as any)?.element_meta ?? null
      const untrusted = [
        `Annotation id: ${a.annotation_id_external}`,
        `Page: ${a.page_url}`,
        a.annotation_url ? `Annotation deep-link: ${a.annotation_url}` : null,
        a.element_selector ? `Element: ${a.element_selector}` : null,
        a.x !== null && a.y !== null ? `Click position: (${a.x}, ${a.y})` : null,
        a.screenshot_url ? `Screenshot: ${a.screenshot_url}` : null,
        elementMeta ? `Element meta: ${JSON.stringify(elementMeta).slice(0, 800)}` : null,
        ``,
        `Reviewer's comment:`,
        a.comment,
        ``,
        `Replies/thread:`,
        repliesText,
      ]
        .filter((l) => l !== null && l !== undefined)
        .join('\n')
      return fenceUntrusted(`untrusted_annotation_${a.annotation_id_external}`, untrusted)
    })
    .join('\n\n')

  const idList = items.map((i) => i.annotation.annotation_id_external).join(', ')

  return [
    `Multiple Revanote annotations from the SAME review were dispatched to you`,
    `together (annotation ids: ${idList}). Address every one of them.`,
    ``,
    `Repo: ${repoPath}`,
    ``,
    SCOPE_CONTRACT,
    trusted
      ? `NOTE: this mapping is operator-TRUSTED — the Deploy plan below overrides rule 4.`
      : null,
    ``,
    fencedItems,
    ``,
    `Deploy plan:`,
    strategyInstructions,
    ``,
    `Before marking ANY comment resolved, in this order:`,
    `  1. Push ONE branch and open ONE pull request covering every comment above.`,
    `  2. Wait for CI to go green.`,
    `  3. Merge the PR yourself.`,
    `  4. Redeploy the site that serves the page_url host(s).`,
    `  5. Re-fetch EACH comment's own page_url and confirm THAT specific change`,
    `     is actually live — a comment is not resolved just because the batch`,
    `     merged.`,
    `Only after all five steps is a comment eligible for "resolved": true. Cite`,
    `the MERGED commit SHA on the repo's default branch as "commit_sha" for`,
    `every resolved comment — not your local working-tree or unmerged`,
    `branch-tip SHA. Any comment you cannot independently verify this way`,
    `gets "resolved": false with a reason — never a guess, and never inherited`,
    `from a sibling comment's success. This is advisory text — the hub`,
    `independently verifies each "commit_sha" against the GitHub remote before`,
    `trusting "resolved": true, and downgrades to false with a reason otherwise.`,
    ``,
    `When you are done with ALL comments above (each resolved OR needing`,
    `clarification), end your reply with ONE machine-readable JSON envelope`,
    `covering every annotation id, on its own lines (no markdown fences inside`,
    `the envelope):`,
    ``,
    `<<JSON>>`,
    `{`,
    `  "annotations": [`,
    `    {`,
    `      "annotation_id": "<the Annotation id from above>",`,
    `      "resolved": true,`,
    `      "action_taken": "short summary of what you did for this comment",`,
    `      "files_changed": ["path/one.tsx"],`,
    `      "commit_sha": "the full commit SHA MERGED to the default branch that made this fix (required when resolved is true)",`,
    `      "deployed": true,`,
    `      "deploy_url": "the live URL you re-fetched to confirm THIS comment's change",`,
    `      "needs_clarification": false`,
    `    }`,
    `    // ... one object per annotation id listed above ...`,
    `  ]`,
    `}`,
    `<<END>>`,
    ``,
    `Include EVERY annotation id listed above in the "annotations" array — one`,
    `you omit is treated as unresolved (\`missing_from_reply\`). For a comment`,
    `you cannot fix autonomously, set "resolved": false, "needs_clarification": true,`,
    `and put a single question in "clarification_question" for that item only.`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n')
}
