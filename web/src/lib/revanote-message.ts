/**
 * Revanote chat-surface helpers (Phase 08).
 *
 * Mirrors `scheduled-message.ts`. The hub stores a revanote-originated
 * user_message with a `[revanote: <comment 30-grapheme preview>]\n\n<full
 * prompt>` prefix; this helper detects it and returns the body + preview so
 * the violet "Annotation" pill renders cleanly.
 *
 * `stripRevanoteEnvelope` removes the `<<JSON>>…<<END>>` block (and any
 * stray ```json fences) from assistant replies so the user sees only the
 * natural-language portion.
 */

export function parseRevanotePrefix(
  content: string,
): { preview: string; body: string } | null {
  const m = content.match(/^\[revanote:\s*([^\]]*)\]\n\n([\s\S]*)$/)
  return m ? { preview: m[1].trim(), body: m[2] } : null
}

const ENVELOPE_RE = /<<JSON>>[\s\S]*?<<END>>/g
const FENCED_JSON_RE = /```json[\s\S]*?```/gi

export function stripRevanoteEnvelope(text: string): string {
  return (text ?? '').replace(ENVELOPE_RE, '').replace(FENCED_JSON_RE, '').trim()
}
