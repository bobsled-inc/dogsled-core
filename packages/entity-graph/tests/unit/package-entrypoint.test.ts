import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('published entrypoints', () => {
  it('keeps the importable library root separate from the executable CLI', () => {
    const buildConfig = readFileSync(path.join(packageRoot, 'tsup.config.ts'), 'utf8');
    const cliWrapper = readFileSync(path.join(packageRoot, 'bin', 'cli.mjs'), 'utf8');

    expect(buildConfig).toContain("index: 'src/api/index.ts'");
    expect(buildConfig).toContain("cli: 'src/index.ts'");
    expect(cliWrapper).toContain("'dist', 'cli.js'");
    expect(cliWrapper).not.toContain("'dist', 'index.js'");
  });
});
