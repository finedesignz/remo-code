/**
 * Tiny mustache-style template renderer (W2/T8.6).
 *
 * Substitutes `{{var}}` with values from ctx. Unknown vars render empty.
 * The `html: true` variant escapes substituted values for safe HTML
 * insertion (email bodies).
 */

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function render(
  template: string,
  ctx: Record<string, unknown>,
  opts: { html?: boolean } = {},
): string {
  return template.replace(VAR_RE, (_m, name: string) => {
    const v = ctx[name]
    if (v === undefined || v === null) return ''
    const s = String(v)
    return opts.html ? htmlEscape(s) : s
  })
}
