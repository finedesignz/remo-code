import { describe, it, expect } from 'bun:test';
import { loadPromptTemplate } from '../src/scheduler/prompts/loader';

// Wave 2: 9 real templates now ship in `hub/src/scheduler/prompts/<workflow>/<step>.md`.
// Tests run against the real on-disk files. No tmp fixtures — those would race
// against shipped templates (afterAll rm could delete them).

describe('loadPromptTemplate', () => {
  it('loads dev/plan with the documented skeleton sections', async () => {
    const txt = await loadPromptTemplate('dev', 'plan');
    expect(txt).toContain('## ROLE');
    expect(txt).toContain('## RUNTIME CONTEXT');
    expect(txt).toContain('## DELIVERABLES');
    expect(txt).toContain('{{user_prompt}}');
    expect(txt.length).toBeGreaterThan(200);
  });

  it('loads every declared workflow + step', async () => {
    const matrix: Array<[Parameters<typeof loadPromptTemplate>[0], string]> = [
      ['dev', 'plan'],
      ['dev', 'execute'],
      ['dev', 'ship'],
      ['security', 'scan'],
      ['security', 'triage'],
      ['security', 'fix-or-issue'],
      ['log_check', 'pull'],
      ['log_check', 'classify'],
      ['log_check', 'triage'],
      ['qc', 'review'],
      ['qc', 'fix'],
      ['qc', 'verify'],
    ];
    for (const [wf, step] of matrix) {
      const txt = await loadPromptTemplate(wf, step);
      expect(txt).toContain('## ROLE');
      expect(txt).toContain('## DELIVERABLES');
    }
  });

  it('throws on unknown workflow', async () => {
    // @ts-expect-error testing runtime guard
    await expect(loadPromptTemplate('bogus', 'plan')).rejects.toThrow(
      /unknown workflow/,
    );
  });

  it('throws on unknown step', async () => {
    await expect(loadPromptTemplate('dev', 'nope')).rejects.toThrow(
      /unknown step/,
    );
  });
});
