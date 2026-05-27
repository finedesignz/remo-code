import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPromptTemplate } from '../src/scheduler/prompts/loader';

// Wave 1 stub: covers load-success + load-missing + invalid-workflow +
// invalid-step. Wave 2 ships the 9 real `.md` templates; at that point
// this file is rewritten to assert against the on-disk fixtures directly.

const promptsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'scheduler',
  'prompts',
);
const fakeFile = join(promptsDir, 'security', 'scan.md');

describe('loadPromptTemplate', () => {
  beforeAll(async () => {
    await mkdir(dirname(fakeFile), { recursive: true });
    await writeFile(fakeFile, '## ROLE\nfixture\n', 'utf8');
  });

  afterAll(async () => {
    await rm(fakeFile, { force: true });
  });

  it('loads an existing template', async () => {
    const txt = await loadPromptTemplate('security', 'scan');
    expect(txt).toContain('## ROLE');
  });

  it('throws on missing template file (ENOENT path)', async () => {
    // log_check/pull is declared valid but not shipped on this Wave 1 branch.
    await expect(loadPromptTemplate('log_check', 'pull')).rejects.toThrow(
      /failed to read template/,
    );
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
