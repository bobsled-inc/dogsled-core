import { afterEach, describe, expect, it } from 'vitest';

import {
  MATCH_KEY_SECRET_RUNTIME_TOKEN,
  hasMatchKeySecretPlaceholder,
  materializeMatchKeySecretPlaceholders,
} from '../../../src/compiler/expr/functions-cleaning.js';
import { LEGACY_MATCH_KEY_SECRET_RUNTIME_TOKENS } from '../../../src/compiler/expr/legacy-names.js';

// Compatibility test: the rename never rewrites this file. Compiled SQL a host stored with an
// earlier spelling of the placeholder still gets the secret.
const SECRET_ENV = 'BOBSLED_CORE_MATCH_KEY_SECRET';
const saved = process.env[SECRET_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = saved;
});

describe('match-key secret placeholder spellings', () => {
  it.each([MATCH_KEY_SECRET_RUNTIME_TOKEN, ...LEGACY_MATCH_KEY_SECRET_RUNTIME_TOKENS])(
    'replaces %s with the secret',
    (token) => {
      process.env[SECRET_ENV] = 's3cret';
      const sql = `SELECT sha256(concat('${token}', x)) FROM t`;
      expect(hasMatchKeySecretPlaceholder(sql)).toBe(true);
      expect(materializeMatchKeySecretPlaceholders(sql, 'duckdb')).toBe(
        "SELECT sha256(concat('s3cret', x)) FROM t"
      );
    }
  );

  it('leaves SQL without a placeholder unchanged', () => {
    expect(hasMatchKeySecretPlaceholder('SELECT 1')).toBe(false);
    expect(materializeMatchKeySecretPlaceholders('SELECT 1', 'duckdb')).toBe('SELECT 1');
  });
});
