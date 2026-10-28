import { describe, expect, it } from 'vitest';

import { readCsv } from '../../../../src/compiler/seed/csv-reader.js';

describe('readCsv', () => {
  it('parses basic CSV', () => {
    const content = 'name,value\nfoo,1\nbar,2\n';
    const result = readCsv(content, {
      delimiter: ',',
      expectedColumns: ['name', 'value'],
    });

    expect(result.headers).toEqual(['name', 'value']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual(['foo', '1']);
    expect(result.rows[1]).toEqual(['bar', '2']);
    expect(result.rowCount).toBe(2);
  });

  it('handles quoted fields with commas', () => {
    const content = 'name,desc\n"Acme, Inc","A company"\n';
    const result = readCsv(content, {
      delimiter: ',',
      expectedColumns: ['name', 'desc'],
    });

    expect(result.rows[0]).toEqual(['Acme, Inc', 'A company']);
  });

  it('handles escaped quotes in quoted fields', () => {
    const content = 'name,desc\n"""Hello""","world"\n';
    const result = readCsv(content, {
      delimiter: ',',
      expectedColumns: ['name', 'desc'],
    });

    expect(result.rows[0]).toEqual(['"Hello"', 'world']);
  });

  it.each([
    ['name\n"unfinished', 'unterminated quoted field'],
    ['name\nnot"quoted', 'quote must begin a field'],
    ['name\n"quoted"tail', 'unexpected character after a quoted field'],
  ])('rejects malformed CSV quoting: %s', (content, message) => {
    expect(() => readCsv(content, { delimiter: ',', expectedColumns: [] })).toThrow(message);
  });

  it('validates expected columns', () => {
    const content = 'name,value\nfoo,1\n';
    expect(() =>
      readCsv(content, {
        delimiter: ',',
        expectedColumns: ['name', 'missing_col'],
      })
    ).toThrow('Expected column "missing_col" not found');
  });

  it('enforces max_rows limit', () => {
    const content = 'name\na\nb\nc\nd\n';
    expect(() =>
      readCsv(content, {
        delimiter: ',',
        maxRows: 2,
        expectedColumns: ['name'],
      })
    ).toThrow('CSV exceeds max_rows limit of 2');
  });

  it('handles pipe delimiter', () => {
    const content = 'name|value\nfoo|1\nbar|2\n';
    const result = readCsv(content, {
      delimiter: '|',
      expectedColumns: ['name', 'value'],
    });

    expect(result.rows[0]).toEqual(['foo', '1']);
  });

  it('handles tab delimiter', () => {
    const content = 'name\tvalue\nfoo\t1\nbar\t2\n';
    const result = readCsv(content, {
      delimiter: '\t',
      expectedColumns: ['name', 'value'],
    });

    expect(result.rows[0]).toEqual(['foo', '1']);
  });

  it('rejects empty CSV', () => {
    expect(() => readCsv('', { delimiter: ',', expectedColumns: ['name'] })).toThrow(
      'CSV file is empty'
    );
  });

  it('requires nonempty, unique headers and accepts a UTF-8 BOM', () => {
    const options = { delimiter: ',', expectedColumns: [] };
    expect(() => readCsv('id,,name\n1,2,3', options)).toThrow('headers must not be empty');
    expect(() => readCsv('id,ID\n1,2', options)).toThrow('duplicate header');
    expect(readCsv('\uFEFFid,name\n1,Ada', options).headers).toEqual(['id', 'name']);
  });

  it('validates row column count', () => {
    const content = 'name,value\nfoo\n';
    expect(() =>
      readCsv(content, {
        delimiter: ',',
        expectedColumns: ['name', 'value'],
      })
    ).toThrow('Row 2 has 1 fields but header has 2 columns');
  });

  it('handles case-insensitive column matching', () => {
    const content = 'Name,VALUE\nfoo,1\n';
    const result = readCsv(content, {
      delimiter: ',',
      expectedColumns: ['name', 'value'],
    });
    expect(result.rowCount).toBe(1);
  });
});
