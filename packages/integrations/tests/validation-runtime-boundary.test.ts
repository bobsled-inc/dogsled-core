import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATION_ENTRY_PATH = join(__dirname, '..', 'src', 'validation', 'index.ts');

describe('validation runtime import boundary', () => {
  it('imports only generated data and type declarations', () => {
    const entry = readFileSync(VALIDATION_ENTRY_PATH, 'utf8');
    const imports = [...entry.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(['./types.js', './generated-data.js']);
  });
});
