import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

import { verifyPreview } from '../../examples/tv-night-ui-preview/verify.mjs';

const root = resolve(import.meta.dirname, '../../examples/tv-night-ui-preview');

it('keeps the standalone tutorial preview self-contained and fixture-backed', async () => {
  await expect(verifyPreview(root)).resolves.toEqual({
    shows: 6,
    episodes: 18,
    externalRuntimeResources: 0,
  });
});

it('detects changes to the checked-in generated preview', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tutorial-ui-preview-'));
  try {
    await cp(root, temporary, {
      recursive: true,
      filter: (path) => !['node_modules', '.build', 'tsconfig.json'].includes(basename(path)),
    });
    const file = join(temporary, 'index.html');
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace('<style>', '<style>/* changed */')
    );
    await expect(verifyPreview(temporary)).rejects.toThrow('Generated HTML size changed');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
