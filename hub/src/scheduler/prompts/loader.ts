import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Workflow = 'dev' | 'security' | 'log_check';

const moduleDir = dirname(fileURLToPath(import.meta.url));

const VALID_STEPS: Record<Workflow, ReadonlySet<string>> = {
  dev: new Set(['plan', 'execute', 'ship']),
  security: new Set(['scan', 'triage', 'fix-or-issue']),
  log_check: new Set(['pull', 'classify', 'triage']),
};

/**
 * Load a workflow-step prompt template from `<workflow>/<step>.md` relative to
 * this module's directory. Returns the raw template text (with `{{var}}`
 * placeholders unrendered). Throws a clear error if the workflow/step pair is
 * unknown or the file is missing.
 */
export async function loadPromptTemplate(
  workflow: Workflow,
  step: string,
): Promise<string> {
  const allowed = VALID_STEPS[workflow];
  if (!allowed) {
    throw new Error(
      `loadPromptTemplate: unknown workflow "${workflow}" (expected dev|security|log_check)`,
    );
  }
  if (!allowed.has(step)) {
    throw new Error(
      `loadPromptTemplate: unknown step "${step}" for workflow "${workflow}" (expected one of ${[...allowed].join(', ')})`,
    );
  }
  const path = join(moduleDir, workflow, `${step}.md`);
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `loadPromptTemplate: failed to read template at ${path}: ${cause}`,
    );
  }
}
