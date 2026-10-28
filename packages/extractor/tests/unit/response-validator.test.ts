import { describe, expect, it } from 'vitest';

import { validateRecords } from '../../src/runtime/response-validator.js';

const output = {
  id: { type: 'integer' as const, path: '$.id' },
  name: { type: 'string' as const, path: '$.name' },
  active: { type: 'boolean' as const, path: '$.active' },
};

describe('validateRecords', () => {
  it('detects extra fields not in schema', () => {
    const records = [
      { id: 1, name: 'Alice', active: true, avatar_url: 'https://example.com/pic.jpg' },
    ];

    const report = validateRecords(records, output);
    const extra = report.issues.find((i) => i.issue === 'extra_field');

    expect(extra).toBeDefined();
    expect(extra!.field).toBe('avatar_url');
    expect(extra!.count).toBe(1);
  });

  it('detects type mismatches', () => {
    const records = [{ id: 'not-a-number', name: 'Alice', active: true }];

    const report = validateRecords(records, output);
    const mismatch = report.issues.find((i) => i.issue === 'type_mismatch');

    expect(mismatch).toBeDefined();
    expect(mismatch!.field).toBe('id');
  });

  it('detects unexpected nulls', () => {
    const records = [{ id: 1, name: null, active: true }];

    const report = validateRecords(records, output);
    const nullIssue = report.issues.find((i) => i.issue === 'unexpected_null');

    expect(nullIssue).toBeDefined();
    expect(nullIssue!.field).toBe('name');
  });

  it('aggregates counts across records', () => {
    const records = [
      { id: 1, name: null, active: true },
      { id: 2, name: null, active: true },
      { id: 3, name: null, active: true },
    ];

    const report = validateRecords(records, output);
    const nullIssue = report.issues.find(
      (i) => i.field === 'name' && i.issue === 'unexpected_null'
    );

    expect(nullIssue!.count).toBe(3);
    expect(report.recordsChecked).toBe(3);
  });

  it('returns no issues for valid records', () => {
    const records = [
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false },
    ];

    const report = validateRecords(records, output);
    expect(report.issues).toHaveLength(0);
  });

  it('does not treat contextual outputs as missing from raw API records', () => {
    const report = validateRecords([{ id: 1 }], {
      id: { type: 'integer', path: '$.id' },
      project_id: {
        type: 'integer',
        from: { resource: 'projects', path: '$.id' },
      },
    });

    expect(report.issues).toEqual([]);
  });

  it('caps validation at 100 records', () => {
    const records = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      active: true,
      extra: 'field',
    }));

    const report = validateRecords(records, output);
    expect(report.recordsChecked).toBe(100);

    const extra = report.issues.find((i) => i.issue === 'extra_field');
    expect(extra!.count).toBe(100);
  });

  it('handles empty records array', () => {
    const report = validateRecords([], output);
    expect(report.issues).toHaveLength(0);
    expect(report.recordsChecked).toBe(0);
  });

  it('skips non-object records', () => {
    const records = ['string', 42, null] as unknown[];
    const report = validateRecords(records, output);
    // Non-objects are skipped, so no issues
    expect(report.recordsChecked).toBe(3);
  });
});
