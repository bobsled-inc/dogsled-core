import { describe, it, expect } from 'vitest';

import { assertSafeIdentifier } from '../../../src/runtime/candidate-retrieval/sql-utils.js';
import { CommandError } from '@bobsled-inc/protocol';

describe('assertSafeIdentifier — accepts', () => {
  it.each([
    ['docs__chunks', 'bare table name'],
    ['analytics.docs', '2-part schema.table'],
    ['proj.ds.tbl', '3-part BigQuery project.dataset.table'],
    ['_internal_table', 'leading underscore'],
    ['Table123', 'mixed case + digits'],
  ])('accepts %s (%s)', (id) => {
    expect(assertSafeIdentifier(id, 'table')).toBe(id);
  });
});

describe('assertSafeIdentifier — rejects', () => {
  it.each([
    [`users'; DROP TABLE x;--`, 'semicolon + quote'],
    [`users' OR 1=1--`, 'quote + comment'],
    [`users\x00`, 'null byte'],
    [`users\nbad`, 'newline'],
    [`users/*comment*/`, 'sql comment'],
    [`'1' UNION SELECT 1`, 'leading quote + space'],
    [`1users`, 'leading digit'],
    [`user-data`, 'hyphen'],
    [`a.b.c.d`, 'four-part identifier'],
    [`users with spaces`, 'whitespace'],
    ['', 'empty string'],
  ])('rejects %s (%s)', (evil) => {
    expect(() => assertSafeIdentifier(evil, 'table')).toThrow(CommandError);
  });
});
