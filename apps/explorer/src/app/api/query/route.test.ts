import { describe, expect, it } from 'vitest';

import { parseLoaderQueryTable } from '../../../lib/loader-query-parser.js';

describe('parseLoaderQueryTable', () => {
  it('parses tabular loader output into structured rows', () => {
    expect(
      parseLoaderQueryTable(
        ['id\tname\tactive\ttotal', '1\tAcme\ttrue\t42', '2\tNULL\tfalse\t3.5'].join('\n')
      )
    ).toEqual([
      { id: 1, name: 'Acme', active: true, total: 42 },
      { id: 2, name: null, active: false, total: 3.5 },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseLoaderQueryTable('')).toEqual([]);
    expect(parseLoaderQueryTable('\n')).toEqual([]);
  });

  it('returns null when rows do not match the header shape', () => {
    expect(parseLoaderQueryTable('id\tname\n1')).toBeNull();
  });

  it('returns null when the header contains duplicate columns', () => {
    expect(parseLoaderQueryTable(['id\tname\tid', '1\tAcme\t2'].join('\n'))).toBeNull();
  });

  it('returns null when the header has an empty column', () => {
    expect(parseLoaderQueryTable(['id\t\tname', '1\tx\tAcme'].join('\n'))).toBeNull();
  });

  it('preserves trailing empty fields', () => {
    expect(parseLoaderQueryTable(['id\tname', '1\t'].join('\n'))).toEqual([{ id: 1, name: '' }]);
  });

  it('keeps leading-zero integer strings as text', () => {
    expect(parseLoaderQueryTable(['id\tname', '007\tAlice'].join('\n'))).toEqual([
      { id: '007', name: 'Alice' },
    ]);
  });

  it('does not pollute Object.prototype when a column is named __proto__', () => {
    const before = ({} as Record<string, unknown>).polluted;
    const rows = parseLoaderQueryTable(['__proto__\tname', '{"polluted":"yes"}\tAlice'].join('\n'));
    expect(rows).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(Object.getPrototypeOf(rows![0])).toBeNull();
  });

  it('does not clobber Object.prototype methods via constructor column', () => {
    const rows = parseLoaderQueryTable(['constructor\tname', 'evil\tAlice'].join('\n'));
    expect(rows).not.toBeNull();
    expect(rows![0]!.constructor).toBe('evil');
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });
});
