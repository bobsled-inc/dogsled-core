import { describe, expect, it } from 'vitest';

import { filterInputsForResource } from '../../src/commands/extract.js';

describe('filterInputsForResource', () => {
  it('returns only keys present in the input schema', () => {
    const inputs = { start_date: '2024-01-01', limit: '100', extra_key: 'should-drop' };
    const schema = {
      start_date: { type: 'string' as const },
      limit: { type: 'integer' as const },
    };
    expect(filterInputsForResource(inputs, schema)).toEqual({
      start_date: '2024-01-01',
      limit: '100',
    });
  });

  it('returns empty object when inputSchema is undefined', () => {
    const inputs = { start_date: '2024-01-01' };
    expect(filterInputsForResource(inputs, undefined)).toEqual({});
  });

  it('returns empty object when no inputs match the schema', () => {
    const inputs = { unknown_key: 'value' };
    const schema = { start_date: { type: 'string' as const } };
    expect(filterInputsForResource(inputs, schema)).toEqual({});
  });

  it('returns empty object when inputs are empty', () => {
    const schema = { start_date: { type: 'string' as const } };
    expect(filterInputsForResource({}, schema)).toEqual({});
  });

  it('returns all inputs when all match the schema', () => {
    const inputs = { start_date: '2024-01-01', end_date: '2024-12-31' };
    const schema = {
      start_date: { type: 'string' as const },
      end_date: { type: 'string' as const },
    };
    expect(filterInputsForResource(inputs, schema)).toEqual(inputs);
  });
});
