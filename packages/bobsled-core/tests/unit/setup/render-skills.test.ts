import { lstatSync, mkdtempSync, readlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderSetupFiles, writeRenderedSetupFiles } from '../../../src/setup/render.js';
import { SetupAnswersSchema } from '../../../src/setup/types.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('setup Project Skills', () => {
  it('writes a starter Skill and configures both adapters', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'bobsled-setup-skills-'));
    roots.push(root);
    const answers = SetupAnswersSchema.parse({
      project: { repo_name: 'example', repo_state: 'new' },
      goals: { summary: 'Sync data.' },
      sources: [],
      destination: { type: 'local', format: 'parquet' },
      credentials: { required_secret_refs: [] },
      status: { missing_items: [] },
    });

    writeRenderedSetupFiles(await renderSetupFiles(answers), root);

    for (const parent of ['.agents', '.claude']) {
      const adapter = path.join(root, parent, 'skills', 'project-overview');
      expect(lstatSync(adapter).isSymbolicLink()).toBe(true);
      expect(readlinkSync(adapter)).toBe('../../skills/project-overview');
    }
  });
});
