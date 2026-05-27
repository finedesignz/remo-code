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

  const deployStrategy = m?.deploy_strategy ?? 'pr'
  const repoPath = m?.repo_path ?? '(no mapping configured for this host — fix in-tree only)'
  const autoMerge = m?.auto_merge === true
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
  const extraContext = [
    elementMeta ? `Element meta: ${JSON.stringify(elementMeta).slice(0, 800)}` : null,
    viewport ? `Capture viewport: ${JSON.stringify(viewport).slice(0, 400)}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  const annotationUrl = a.annotation_url
    ? `Annotation deep-link: ${a.annotation_url}\n`
    : ''

  return [
    `A reviewer left a Revanote annotation on a deployed page. Please address it.`,
    ``,
    `Repo: ${repoPath}`,
    `Page: ${a.page_url}`,
    annotationUrl ? annotationUrl : null,
    a.element_selector ? `Element: \`${a.element_selector}\`` : null,
    a.x !== null && a.y !== null ? `Click position: (${a.x}, ${a.y})` : null,
    a.screenshot_url ? `Screenshot: ${a.screenshot_url}` : null,
    extraContext || null,
    ``,
    `Reviewer's comment:`,
    `> ${a.comment.replace(/\n/g, '\n> ')}`,
    ``,
    `Replies/thread:`,
    repliesText,
    ``,
    `Deploy plan:`,
    strategyInstructions,
    ``,
    `When you are done (resolved OR clarification needed), end your reply with a`,
    `machine-readable JSON envelope so the hub can post a callback. Use exactly`,
    `this format on its own lines (no markdown fences inside the envelope):`,
    ``,
    `<<JSON>>`,
    `{`,
    `  "resolved": true,`,
    `  "action_taken": "short summary of what you did",`,
    `  "files_changed": ["path/one.tsx", "path/two.ts"],`,
    `  "deployed": true,`,
    `  "needs_clarification": false`,
    `}`,
    `<<END>>`,
    ``,
    `If you cannot fix it autonomously, set "resolved": false, "needs_clarification": true,`,
    `and put a single question in "clarification_question".`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n')
}
