import { describe, expect, it } from 'vitest';

import { compareCursors, maxCursor, inferCursorKind } from '../../src/runtime/cursor.js';

describe('compareCursors', () => {
  describe('integer', () => {
    it('returns -1 when a < b', () => {
      expect(compareCursors('1', '2', 'integer')).toBe(-1);
    });

    it('returns 0 when equal', () => {
      expect(compareCursors('42', '42', 'integer')).toBe(0);
    });

    it('returns 1 when a > b', () => {
      expect(compareCursors('100', '5', 'integer')).toBe(1);
    });

    it('handles large numbers', () => {
      expect(compareCursors('9999999999', '1000000000', 'integer')).toBe(1);
    });
  });

  describe('timestamp', () => {
    it('returns -1 when a is earlier', () => {
      expect(compareCursors('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', 'timestamp')).toBe(-1);
    });

    it('returns 0 when equal', () => {
      expect(compareCursors('2026-03-20T12:00:00Z', '2026-03-20T12:00:00Z', 'timestamp')).toBe(0);
    });

    it('returns 1 when a is later', () => {
      expect(compareCursors('2026-12-01T00:00:00Z', '2026-01-01T00:00:00Z', 'timestamp')).toBe(1);
    });

    it('handles millisecond differences', () => {
      expect(
        compareCursors('2026-03-20T12:00:00.001Z', '2026-03-20T12:00:00.000Z', 'timestamp')
      ).toBe(1);
    });
  });

  describe('string', () => {
    it('returns -1 when a < b lexicographically', () => {
      expect(compareCursors('abc', 'xyz', 'string')).toBe(-1);
    });

    it('returns 0 when equal', () => {
      expect(compareCursors('same', 'same', 'string')).toBe(0);
    });

    it('returns 1 when a > b lexicographically', () => {
      expect(compareCursors('z', 'a', 'string')).toBe(1);
    });
  });

  describe('lsn', () => {
    it('orders smaller LSNs before larger ones', () => {
      expect(compareCursors('16/B374D848', '16/B374D849', 'lsn')).toBe(-1);
    });

    it('compares the upper 32 bits before the lower 32 bits', () => {
      expect(compareCursors('16/FFFFFFFF', '17/00000001', 'lsn')).toBe(-1);
    });

    it('treats identical LSNs as equal', () => {
      expect(compareCursors('16/B374D848', '16/B374D848', 'lsn')).toBe(0);
    });

    it('rejects non-canonical LSN chunks wider than 32 bits', () => {
      expect(() => compareCursors('0/100000000', '1/0', 'lsn')).toThrow(
        'Invalid lsn cursor: "0/100000000"'
      );
    });
  });
});

describe('maxCursor', () => {
  it('returns candidate when it is greater', () => {
    expect(maxCursor('10', '20', 'integer')).toBe('20');
  });

  it('returns current when candidate is smaller', () => {
    expect(maxCursor('20', '10', 'integer')).toBe('20');
  });

  it('returns current when equal', () => {
    expect(maxCursor('42', '42', 'integer')).toBe('42');
  });

  it('works with timestamps', () => {
    expect(maxCursor('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', 'timestamp')).toBe(
      '2026-06-01T00:00:00Z'
    );
  });

  it('works with strings', () => {
    expect(maxCursor('alpha', 'beta', 'string')).toBe('beta');
  });

  it('works with LSNs', () => {
    expect(maxCursor('16/B374D848', '16/B374D849', 'lsn')).toBe('16/B374D849');
  });
});

describe('inferCursorKind', () => {
  it('detects ISO timestamps', () => {
    expect(inferCursorKind('2026-03-20T12:00:00Z')).toBe('timestamp');
  });

  it('detects date-only ISO format', () => {
    expect(inferCursorKind('2026-03-20 12:00:00')).toBe('timestamp');
  });

  it('detects integers', () => {
    expect(inferCursorKind('42')).toBe('integer');
  });

  it('detects LSN values', () => {
    expect(inferCursorKind('16/B374D848')).toBe('lsn');
  });

  it('detects negative integers', () => {
    expect(inferCursorKind('-5')).toBe('integer');
  });

  it('detects zero', () => {
    expect(inferCursorKind('0')).toBe('integer');
  });

  it('falls back to string for other values', () => {
    expect(inferCursorKind('abc123')).toBe('string');
  });

  it('treats decimal numbers as number', () => {
    expect(inferCursorKind('3.14')).toBe('number');
  });
});
