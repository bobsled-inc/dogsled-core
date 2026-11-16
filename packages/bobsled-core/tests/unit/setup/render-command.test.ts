import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSetupGroup } from '../../../src/groups/setup.js';

const ANSWERS_YAML = `project:
  repo_name: example
  repo_state: new
goals:
  summary: Sync data.
sources: []
destination:
  type: local
  format: parquet
credentials:
  required_secret_refs: []
status:
  missing_items: []
`;

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createRootWithAnswers(): { root: string; answersPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-setup-render-cmd-'));
  roots.push(root);
  const answersPath = path.join(root, 'answers.yml');
  writeFileSync(answersPath, ANSWERS_YAML, 'utf-8');
  return { root, answersPath };
}

function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

async function runRender(args: string[]): Promise<void> {
  await createSetupGroup().parseAsync(['render', ...args], { from: 'user' });
}

describe('setup render command output', () => {
  it('reports written files and flags preserved ones in text mode', async () => {
    const { root, answersPath } = createRootWithAnswers();
    const authored = '# example — Agent Guide\n\nHand-written.\n';
    writeFileSync(path.join(root, 'AGENTS.md'), authored, 'utf-8');
    const chunks = captureStdout();

    await runRender(['--answers', answersPath, '--out-dir', root]);

    const output = chunks.join('');
    expect(output).toContain('Rendered 9 setup files.');
    expect(output).toContain(
      'Preserved existing AGENTS.md (edit it in place, or delete it to regenerate the scaffold).'
    );
    expect(output).toContain('dogsled.yml\n');
    expect(output).not.toMatch(/AGENTS\.md\n/);
    expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf-8')).toBe(authored);
  });

  it('preserves the existing JSON artifact-list contract', async () => {
    const { root, answersPath } = createRootWithAnswers();
    writeFileSync(path.join(root, 'AGENTS.md'), '# authored\n', 'utf-8');
    const chunks = captureStdout();

    await runRender(['--answers', answersPath, '--out-dir', root, '--json']);

    const lines = chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const paths = JSON.parse(lines[0] as string) as string[];
    expect(Array.isArray(paths)).toBe(true);
    expect(paths).toContain('dogsled.yml');
    expect(paths).toContain('skills/project-overview/SKILL.md');
    expect(paths).toContain('AGENTS.md');
  });
});
