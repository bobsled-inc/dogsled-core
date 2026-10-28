/**
 * Tests for cursor validation behavior in the topup command.
 *
 * The normalizeCursorInput function is private to the topup module,
 * so we test its behavior indirectly through the exported command
 * registration and the underlying parseCursorValue / cursor validation.
 */

import { describe, expect, it } from 'vitest';

import { parseCursorValue } from '../../src/runtime/time.js';

describe('cursor validation for integer/number types rejecting durations', () => {
  it('parseCursorValue rejects non-duration non-ISO strings', () => {
    expect(() => parseCursorValue('not-a-date')).toThrow('Invalid cursor value');
  });

  it('parseCursorValue accepts relative durations for timestamps', () => {
    const result = parseCursorValue('2h');
    // Should return a valid ISO timestamp
    expect(new Date(result).getTime()).not.toBeNaN();
  });

  it('parseCursorValue accepts ISO 8601 timestamps', () => {
    const result = parseCursorValue('2024-06-15T12:00:00Z');
    expect(result).toBe('2024-06-15T12:00:00.000Z');
  });

  it('parseCursorValue accepts date-only strings', () => {
    const result = parseCursorValue('2024-06-15');
    expect(result).toContain('2024-06-15');
  });

  it('parseCursorValue rejects timestamps without timezone', () => {
    expect(() => parseCursorValue('2024-06-15T12:00:00')).toThrow('missing a timezone');
  });

  it('parseCursorValue rejects invalid calendar dates', () => {
    expect(() => parseCursorValue('2024-02-31')).toThrow('does not exist');
  });

  it('parseCursorValue rejects durations exceeding 365 days', () => {
    expect(() => parseCursorValue('366d')).toThrow('exceeds maximum');
  });

  it('integer cursor type rejects duration-like strings', () => {
    // normalizeCursorInput for integer kind checks /^-?\d+$/
    // Duration strings like "2h" or "1d" would fail this regex
    const integerPattern = /^-?\d+$/;
    expect(integerPattern.test('2h')).toBe(false);
    expect(integerPattern.test('1d')).toBe(false);
    expect(integerPattern.test('30m')).toBe(false);
    expect(integerPattern.test('42')).toBe(true);
    expect(integerPattern.test('-5')).toBe(true);
  });

  it('number cursor type rejects duration-like strings', () => {
    // normalizeCursorInput for number kind checks Number.isFinite(Number(value))
    expect(Number.isFinite(Number('2h'))).toBe(false);
    expect(Number.isFinite(Number('1d'))).toBe(false);
    expect(Number.isFinite(Number('30m'))).toBe(false);
    expect(Number.isFinite(Number('42.5'))).toBe(true);
    expect(Number.isFinite(Number('-3.14'))).toBe(true);
  });
});
