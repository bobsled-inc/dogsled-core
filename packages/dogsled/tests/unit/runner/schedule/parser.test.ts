import { describe, expect, it } from 'vitest';

import {
  cronToHumanSlug,
  isValidSchedule,
  parseToCron,
} from '../../../../src/runner/schedule/parser.js';

describe('parseToCron', () => {
  describe('named presets', () => {
    it.each([
      ['hourly', '0 * * * *'],
      ['daily', '0 6 * * *'],
      ['weekly', '0 6 * * 1'],
      ['monthly', '0 6 1 * *'],
    ])('%s → %s', (input, expected) => {
      expect(parseToCron(input)).toBe(expected);
    });
  });

  describe('case insensitivity', () => {
    it.each([
      ['Hourly', '0 * * * *'],
      ['DAILY', '0 6 * * *'],
      ['Weekly', '0 6 * * 1'],
    ])('%s → %s', (input, expected) => {
      expect(parseToCron(input)).toBe(expected);
    });
  });

  describe('whitespace trimming', () => {
    it('trims leading/trailing whitespace', () => {
      expect(parseToCron('  hourly  ')).toBe('0 * * * *');
    });
  });

  describe('every N intervals', () => {
    it.each([
      ['every 2h', '0 */2 * * *'],
      ['every 4h', '0 */4 * * *'],
      ['every 6h', '0 */6 * * *'],
      ['every 12h', '0 */12 * * *'],
      ['every 1h', '0 */1 * * *'],
      ['every 15m', '*/15 * * * *'],
      ['every 30m', '*/30 * * * *'],
      ['every 5m', '*/5 * * * *'],
    ])('%s → %s', (input, expected) => {
      expect(parseToCron(input)).toBe(expected);
    });
  });

  describe('offset past interval', () => {
    it.each([
      ['30 past hourly', '30 * * * *'],
      ['15 past hourly', '15 * * * *'],
      ['0 past hourly', '0 * * * *'],
      ['15 past every 2h', '15 */2 * * *'],
      ['30 past every 4h', '30 */4 * * *'],
      ['45 past every 6h', '45 */6 * * *'],
    ])('%s → %s', (input, expected) => {
      expect(parseToCron(input)).toBe(expected);
    });
  });

  describe('daily at specific time', () => {
    it.each([
      ['daily at 8', '0 8 * * *'],
      ['daily at 14:30', '30 14 * * *'],
      ['daily at 0', '0 0 * * *'],
      ['daily at 23:59', '59 23 * * *'],
      ['daily at 2am', '0 2 * * *'],
      ['daily at 2pm', '0 14 * * *'],
      ['daily at 12pm', '0 12 * * *'],
      ['daily at 12am', '0 0 * * *'],
    ])('%s → %s', (input, expected) => {
      expect(parseToCron(input)).toBe(expected);
    });
  });

  describe('raw cron pass-through', () => {
    it.each([
      ['0 */4 * * *'],
      ['*/15 * * * *'],
      ['30 14 * * *'],
      ['0 6 * * 1-5'],
      ['0 0 1,15 * *'],
    ])('passes through valid cron: %s', (cron) => {
      expect(parseToCron(cron)).toBe(cron);
    });
  });

  describe('invalid inputs', () => {
    it('throws on empty string', () => {
      expect(() => parseToCron('')).toThrow();
    });

    it('throws on whitespace-only', () => {
      expect(() => parseToCron('   ')).toThrow();
    });

    it('throws on unrecognized string', () => {
      expect(() => parseToCron('biweekly')).toThrow(/Unrecognized schedule/);
    });

    it('throws on invalid every', () => {
      expect(() => parseToCron('every 0h')).toThrow();
      expect(() => parseToCron('every 25h')).toThrow();
      expect(() => parseToCron('every 7h')).toThrow();
      expect(() => parseToCron('every 0m')).toThrow();
      expect(() => parseToCron('every 61m')).toThrow();
      expect(() => parseToCron('every 17m')).toThrow();
    });

    it('throws on uneven offset intervals', () => {
      expect(() => parseToCron('15 past every 7h')).toThrow();
    });

    it('throws on out-of-range raw cron fields', () => {
      expect(() => parseToCron('61 24 * * *')).toThrow();
      expect(() => parseToCron('0 0 0 0 0')).toThrow();
    });

    it('throws on gibberish', () => {
      expect(() => parseToCron('not a schedule')).toThrow();
    });

    it('throws with exit code 2', () => {
      expect.assertions(1);
      try {
        parseToCron('invalid');
      } catch (e: unknown) {
        expect((e as { exitCode: number }).exitCode).toBe(2);
      }
    });
  });
});

describe('isValidSchedule', () => {
  it('returns true for valid schedules', () => {
    expect(isValidSchedule('hourly')).toBe(true);
    expect(isValidSchedule('every 4h')).toBe(true);
    expect(isValidSchedule('0 */4 * * *')).toBe(true);
    expect(isValidSchedule('daily at 14:30')).toBe(true);
  });

  it('returns false for invalid schedules', () => {
    expect(isValidSchedule('')).toBe(false);
    expect(isValidSchedule('not valid')).toBe(false);
    expect(isValidSchedule('biweekly')).toBe(false);
  });
});

describe('cronToHumanSlug', () => {
  it.each([
    ['0 * * * *', 'hourly'],
    ['0 6 * * *', 'daily'],
    ['0 6 * * 1', 'weekly'],
    ['0 6 1 * *', 'monthly'],
    ['0 */4 * * *', 'every-4h'],
    ['0 */2 * * *', 'every-2h'],
    ['*/15 * * * *', 'every-15m'],
    ['*/30 * * * *', 'every-30m'],
    ['30 */4 * * *', '30-past-every-4h'],
    ['15 */2 * * *', '15-past-every-2h'],
    ['0 8 * * *', 'daily-at-8'],
    ['30 14 * * *', 'daily-at-14-30'],
    ['0 0 * * *', 'daily-at-0'],
  ])('%s → %s', (cron, expected) => {
    expect(cronToHumanSlug(cron)).toBe(expected);
  });

  it('sanitizes unknown cron patterns into safe slugs', () => {
    const slug = cronToHumanSlug('0 6 * * 1-5');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });
});
