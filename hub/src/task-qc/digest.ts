/**
 * PTYCAP-08 task-quality digest builder (tracer scope; plan 07 hardens it).
 * Pure over typed Finding fields. Every value goes through safeText on the way
 * in (so output is ASCII, control-free) and HTML-escaped on the way into the
 * html part. Proposals render from a fixed template per kind: never free text.
 */
import { safeText, type Finding, type Proposal } from './types.ts'

export interface TaskQcDigest {
  subject: string
  text: string
  html: string
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function evidenceLines(f: Finding): string[] {
  const lines: string[] = []
  for (const [k, v] of Object.entries(f.evidence)) {
    const val = Array.isArray(v) ? v.map((x) => safeText(x, 80)).join(', ') : safeText(v, 120)
    lines.push(`${safeText(k, 40)}: ${val}`)
  }
  return lines
}

/** Fixed template per proposal kind. The propose_disable template names the exact PATCH a human can send. */
export function describeProposal(p: Proposal, taskId: string): string {
  const id = safeText(p.params.taskId ?? taskId, 64)
  switch (p.kind) {
    case 'propose_disable':
      return `Proposal (not applied): disable this task if it should stop running. Send PATCH /api/scheduled-tasks/${id} with body {"enabled":false}.`
    case 'reregister_job':
      return `Proposal (not applied): re-arm the job. Send PATCH /api/scheduled-tasks/${id} with body {"enabled":true}.`
    default:
      return `Proposal (not applied): ${safeText(p.kind, 40)} for task ${id}.`
  }
}

export function buildTaskQcDigest(findings: Finding[]): TaskQcDigest | null {
  if (findings.length === 0) return null
  const subject = `Task quality: ${findings.length} finding${findings.length === 1 ? '' : 's'} need review`
  const textBlocks: string[] = []
  const htmlBlocks: string[] = []
  for (const f of findings) {
    const head = `${safeText(f.detector, 24)} [${safeText(f.severity, 8)}] ${safeText(f.taskName)} (${safeText(f.taskId, 64)})`
    const ev = evidenceLines(f)
    const prop = describeProposal(f.proposal, f.taskId)
    textBlocks.push([head, ...ev.map((l) => `  ${l}`), `  ${prop}`].join('\n'))
    htmlBlocks.push(
      `<h3>${esc(head)}</h3><ul>${ev.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p>${esc(prop)}</p>`,
    )
  }
  const text = `${subject}\n\n${textBlocks.join('\n\n')}\n`
  const html = `<p>${esc(subject)}</p>${htmlBlocks.join('')}`
  return { subject, text, html }
}
