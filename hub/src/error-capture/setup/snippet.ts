/**
 * Sentry SDK snippet generator + idempotent injector (W5).
 *
 * Lifted from claude-code-self-heal/src/setup/snippet.ts and reshaped to the
 * 4 Wave-5 stacks. Each call returns `entry_prepend` (text to insert into the
 * entry file) plus a `manifest_patch` op that either edits package.json
 * dependencies or appends to requirements.txt.
 *
 * All write helpers are idempotent: if Sentry init / dep is already present,
 * we return `{ alreadyConfigured: true }` and leave content unchanged.
 */

import type { Stack } from './detect.ts'

export interface SnippetPlan {
  entry_prepend: string
  manifest_kind: 'package.json' | 'requirements.txt'
}

export function getSnippet(stack: Stack, dsn: string): SnippetPlan {
  switch (stack) {
    case 'node-express':
      return {
        entry_prepend: [
          `// --- Sentry (Remo error capture) — added automatically ---`,
          `import * as Sentry from '@sentry/node';`,
          `Sentry.init({ dsn: '${dsn}', tracesSampleRate: 1.0 });`,
          `// --- end Sentry ---`,
          '',
        ].join('\n'),
        manifest_kind: 'package.json',
      }
    case 'node-nextjs':
      return {
        entry_prepend: [
          `// --- Sentry (Remo error capture) — added automatically ---`,
          `import * as Sentry from '@sentry/nextjs';`,
          `Sentry.init({ dsn: '${dsn}', tracesSampleRate: 1.0 });`,
          `// --- end Sentry ---`,
          '',
        ].join('\n'),
        manifest_kind: 'package.json',
      }
    case 'python-fastapi':
    case 'python-django':
      return {
        entry_prepend: [
          `# --- Sentry (Remo error capture) — added automatically ---`,
          `import sentry_sdk`,
          `sentry_sdk.init(dsn="${dsn}", traces_sample_rate=1.0)`,
          `# --- end Sentry ---`,
          '',
        ].join('\n'),
        manifest_kind: 'requirements.txt',
      }
  }
}

/**
 * Idempotent injection of the Sentry init snippet into an entry file.
 *
 * Detects existing Sentry init by string signature (`@sentry/node`,
 * `@sentry/nextjs`, `sentry_sdk`). Preserves `#!shebang` lines.
 */
export function injectSnippet(
  source: string,
  snippet: string,
): { content: string; alreadyConfigured: boolean } {
  if (
    source.includes('@sentry/node') ||
    source.includes('@sentry/nextjs') ||
    source.includes('sentry_sdk')
  ) {
    return { content: source, alreadyConfigured: true }
  }

  if (source.startsWith('#!')) {
    const newlineIdx = source.indexOf('\n')
    if (newlineIdx === -1) {
      return { content: source + '\n' + snippet, alreadyConfigured: false }
    }
    const shebang = source.slice(0, newlineIdx + 1)
    const rest = source.slice(newlineIdx + 1)
    return { content: shebang + snippet + rest, alreadyConfigured: false }
  }

  return { content: snippet + source, alreadyConfigured: false }
}

/**
 * Idempotent dep add for package.json. Chooses `@sentry/nextjs` for
 * `node-nextjs`, else `@sentry/node`.
 */
export function addSentryDep(
  packageJsonContent: string,
  stack: Extract<Stack, 'node-express' | 'node-nextjs'>,
): { content: string; alreadyConfigured: boolean } {
  const depName = stack === 'node-nextjs' ? '@sentry/nextjs' : '@sentry/node'
  let pkg: any
  try {
    pkg = JSON.parse(packageJsonContent)
  } catch {
    return { content: packageJsonContent, alreadyConfigured: false }
  }
  const deps = (pkg.dependencies ?? {}) as Record<string, string>
  if (deps[depName]) {
    return { content: packageJsonContent, alreadyConfigured: true }
  }
  const next = {
    ...pkg,
    dependencies: { ...deps, [depName]: '^9.0.0' },
  }
  // preserve trailing newline if original had one
  const trailing = packageJsonContent.endsWith('\n') ? '\n' : ''
  return { content: JSON.stringify(next, null, 2) + trailing, alreadyConfigured: false }
}

const PY_REQ_LINE = 'sentry-sdk>=2.0.0'

export function addPythonSentryRequirement(
  requirementsTxt: string,
): { content: string; alreadyConfigured: boolean } {
  if (/^sentry[-_]sdk\b/im.test(requirementsTxt)) {
    return { content: requirementsTxt, alreadyConfigured: true }
  }
  const trailingNewline = requirementsTxt.length === 0 || requirementsTxt.endsWith('\n')
  const content = (trailingNewline ? requirementsTxt : requirementsTxt + '\n') + PY_REQ_LINE + '\n'
  return { content, alreadyConfigured: false }
}
