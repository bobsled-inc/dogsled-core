import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT_CONFIG_FILE_SPELLINGS } from '@bobsled-inc/project-index';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSetupGroup } from '../../../src/groups/setup.js';
import {
  SETUP_ANSWERS_FILE_SPELLINGS,
  SETUP_DASHBOARD_STATE_FILE_SPELLINGS,
} from '../../../src/setup/legacy-names.js';

const ANSWERS_YAML = `project:
  repo_name: example
  repo_state: existing
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

const ROOT_CONFIG_CONTENT = 'version: 1\npipelines: {}\n';
// The earlier generation's names, taken from the reader's list so this file names no old spelling.
const OLD_ANSWERS = SETUP_ANSWERS_FILE_SPELLINGS[0]!;
const OLD_ROOT = OLD_ANSWERS.replace('.setup.answers', '');

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createRoot(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'setup-render-spellings-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, name), content, 'utf-8');
  }
  return root;
}

async function render(root: string): Promise<string[]> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  await createSetupGroup().parseAsync(
    [
      'render',
      '--answers',
      path.join(root, 'bobsled.setup.answers.yml'),
      '--out-dir',
      root,
      '--json',
    ],
    { from: 'user' }
  );
  return JSON.parse(chunks.join('').trim()) as string[];
}

describe('setup render in a project from an earlier Core generation', () => {
  it('rewrites the existing earlier root config and answers file instead of adding copies', async () => {
    const root = createRoot({
      [OLD_ROOT]: ROOT_CONFIG_CONTENT,
      [OLD_ANSWERS]: ANSWERS_YAML,
    });

    const paths = await render(root);

    expect(ROOT_CONFIG_FILE_SPELLINGS).toContain(OLD_ROOT);
    expect(OLD_ROOT).not.toBe('bobsled.yml');
    expect(paths).toContain(OLD_ROOT);
    expect(paths).toContain(OLD_ANSWERS);
    expect(paths).not.toContain('bobsled.yml');
    expect(paths).not.toContain('bobsled.setup.answers.yml');
    expect(existsSync(path.join(root, 'bobsled.yml'))).toBe(false);
    expect(existsSync(path.join(root, 'bobsled.setup.answers.yml'))).toBe(false);
    expect(readFileSync(path.join(root, OLD_ROOT), 'utf-8')).not.toBe(ROOT_CONFIG_CONTENT);
  });

  it('keeps writing bobsled.yml when the project already has one', async () => {
    const root = createRoot({
      'bobsled.yml': ROOT_CONFIG_CONTENT,
      [OLD_ROOT]: ROOT_CONFIG_CONTENT,
      'bobsled.setup.answers.yml': ANSWERS_YAML,
    });

    const paths = await render(root);

    expect(paths).toContain('bobsled.yml');
    expect(paths).not.toContain(OLD_ROOT);
    expect(readFileSync(path.join(root, OLD_ROOT), 'utf-8')).toBe(ROOT_CONFIG_CONTENT);
  });

  it('writes bobsled.yml in a new project', async () => {
    const root = createRoot({ 'bobsled.setup.answers.yml': ANSWERS_YAML });

    const paths = await render(root);

    expect(paths).toContain('bobsled.yml');
    expect(paths).toContain('bobsled.setup.answers.yml');
    expect(existsSync(path.join(root, OLD_ROOT))).toBe(false);
  });

  it('rewrites whichever dashboard state file the project already has', async () => {
    for (const [index, existing] of SETUP_DASHBOARD_STATE_FILE_SPELLINGS.entries()) {
      const other = SETUP_DASHBOARD_STATE_FILE_SPELLINGS[1 - index]!;
      const root = createRoot({ 'bobsled.setup.answers.yml': ANSWERS_YAML, [existing]: '{}\n' });

      const paths = await render(root);

      expect(paths).toContain(existing);
      expect(paths).not.toContain(other);
      expect(existsSync(path.join(root, other))).toBe(false);
      expect(readFileSync(path.join(root, existing), 'utf-8')).not.toBe('{}\n');
      vi.restoreAllMocks();
    }
  });
});
