import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { parseCursorValue } from '../../src/runtime/time.js';

describe('parseCursorValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves "2h" to ISO timestamp 2 hours before now', () => {
    const result = parseCursorValue('2h');
    expect(result).toBe('2026-03-22T10:00:00.000Z');
  });

  it('resolves "30m" to ISO timestamp 30 minutes before now', () => {
    const result = parseCursorValue('30m');
    expect(result).toBe('2026-03-22T11:30:00.000Z');
  });

  it('resolves "1d" to ISO timestamp 24 hours before now', () => {
    const result = parseCursorValue('1d');
    expect(result).toBe('2026-03-21T12:00:00.000Z');
  });

  it('normalizes ISO 8601 timestamp to full format', () => {
    const result = parseCursorValue('2026-03-20T00:00:00Z');
    expect(result).toBe('2026-03-20T00:00:00.000Z');
  });

  it('normalizes date-only input to full ISO timestamp', () => {
    const result = parseCursorValue('2026-03-20');
    expect(result).toBe('2026-03-20T00:00:00.000Z');
  });

  it('throws on invalid value', () => {
    expect(() => parseCursorValue('invalid')).toThrow('Invalid cursor value "invalid"');
  });

  it('throws on empty string', () => {
    expect(() => parseCursorValue('')).toThrow('Invalid cursor value ""');
  });

  it('throws on relative duration exceeding max', () => {
    expect(() => parseCursorValue('400d')).toThrow('exceeds maximum of 365 days');
  });
});
