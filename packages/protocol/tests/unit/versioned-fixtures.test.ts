import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseStderrMessage, parseStdoutMessage } from '../../src/index.js';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/v1');

describe('versioned protocol fixtures', () => {
  for (const fileName of fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    it(`parses ${fileName}`, () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, fileName), 'utf8'));
      const parsed = fileName.startsWith('stderr-')
        ? parseStderrMessage(fixture)
        : parseStdoutMessage(fixture);

      expect(parsed).not.toBeNull();
      expect(parsed).toEqual(fixture);
    });
  }
});
