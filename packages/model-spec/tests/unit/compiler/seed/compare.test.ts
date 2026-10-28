import { describe, expect, it } from 'vitest';

import { canonicalSeedValue, warehouseValueText } from '../../../../src/compiler/seed/compare.js';

describe('seed diff value comparison', () => {
  it('unwraps driver values', () => {
    expect(warehouseValueText({ value: '2025-01-01' })).toBe('2025-01-01');
    expect(warehouseValueText(null)).toBe('');
    expect(warehouseValueText(new Date('2025-01-01T10:00:00Z'))).toBe('2025-01-01T10:00:00.000Z');
    expect(warehouseValueText(12.5)).toBe('12.5');
  });

  it('compares numbers by value, keeping big integers exact', () => {
    expect(canonicalSeedValue('007', 'integer')).toBe('7');
    expect(canonicalSeedValue('9007199254740993', 'integer')).toBe('9007199254740993');
    expect(canonicalSeedValue('1.50', 'exact')).toBe(canonicalSeedValue('1.500000000', 'exact'));
    expect(canonicalSeedValue('-0.0', 'exact')).toBe('0');
    expect(canonicalSeedValue('10', 'float')).toBe(canonicalSeedValue('10.0', 'float'));
    expect(canonicalSeedValue('1e3', 'float')).toBe('1000');
  });

  it('compares booleans, dates and timestamps by meaning', () => {
    expect(canonicalSeedValue('yes', 'boolean')).toBe(canonicalSeedValue('true', 'boolean'));
    expect(canonicalSeedValue('0', 'boolean')).toBe('false');
    expect(canonicalSeedValue('2025-01-01', 'date')).toBe('2025-01-01');
    const expected = '2025-01-01T10:00:00.000Z';
    expect(canonicalSeedValue('2025-01-01 10:00:00', 'timestamp')).toBe(expected);
    expect(canonicalSeedValue('2025-01-01T10:00:00.000Z', 'timestamp')).toBe(expected);
    expect(canonicalSeedValue('2025-01-01 10:00:00.000', 'timestamp')).toBe(expected);
    expect(canonicalSeedValue('2025-01-01 10:00:00+00', 'timestamp')).toBe(expected);
    expect(canonicalSeedValue('2025-01-01 10:00:00.000 +0000', 'timestamp')).toBe(expected);
    expect(canonicalSeedValue('2025-01-01', 'timestamp')).toBe('2025-01-01T00:00:00.000Z');
  });

  it('keeps text exact, including whitespace', () => {
    expect(canonicalSeedValue(' a ', 'text')).toBe(' a ');
    expect(canonicalSeedValue('', 'integer')).toBe('');
  });
});
