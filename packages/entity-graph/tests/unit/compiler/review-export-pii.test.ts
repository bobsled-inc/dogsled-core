import { describe, expect, it } from 'vitest';
import { applyPiiRedaction, formatExport } from '../../../src/compiler/identity/review-export.js';
import type { ReviewExportRow } from '../../../src/compiler/identity/types.js';

function makeRow(overrides: Partial<ReviewExportRow> = {}): ReviewExportRow {
  return {
    pair_id: 'pair-1',
    record_a_id: 'a-1',
    record_b_id: 'b-1',
    source_a: 'crm',
    source_b: 'erp',
    composite_score: 0.85,
    threshold_band: 'review',
    blocking_rules: '[]',
    field_diffs: JSON.stringify({ name: 'Alice', email: 'alice@example.com', ssn: '123-45-6789' }),
    recommended_action: 'merge',
    semantic_score: null,
    semantic_decision: null,
    decision: null,
    confidence: null,
    reviewer: null,
    reason: null,
    proposed_decision: null,
    proposed_confidence: null,
    confidence_gap: null,
    decided_at: null,
    decision_source: null,
    decision_batch_id: null,
    applied_at: null,
    ...overrides,
  };
}

describe('applyPiiRedaction', () => {
  it('returns rows unchanged when piiFields is empty', () => {
    const rows = [makeRow()];
    const result = applyPiiRedaction(rows, []);
    expect(result).toBe(rows);
  });

  it('redacts specified fields in field_diffs', () => {
    const rows = [makeRow()];
    const result = applyPiiRedaction(rows, ['ssn', 'email']);
    const diffs = JSON.parse(result[0]!.field_diffs!) as Record<string, unknown>;
    expect(diffs['name']).toBe('Alice');
    expect(diffs['email']).toBe('[REDACTED]');
    expect(diffs['ssn']).toBe('[REDACTED]');
  });

  it('does not mutate the original row', () => {
    const rows = [makeRow()];
    const original = rows[0]!.field_diffs;
    applyPiiRedaction(rows, ['ssn']);
    expect(rows[0]!.field_diffs).toBe(original);
  });

  it('returns row unchanged when field_diffs is null/undefined', () => {
    const rows = [makeRow({ field_diffs: null })];
    const result = applyPiiRedaction(rows, ['ssn']);
    expect(result[0]!.field_diffs).toBeNull();
  });

  it('returns row unchanged when field_diffs is invalid JSON', () => {
    const rows = [makeRow({ field_diffs: 'not-json' })];
    const result = applyPiiRedaction(rows, ['ssn']);
    expect(result[0]!.field_diffs).toBe('not-json');
  });
});

describe('formatExport with piiRedactFields', () => {
  it('applies redaction when piiRedactFields option is set', () => {
    const rows = [makeRow()];
    const csv = formatExport(rows, 'csv', { piiRedactFields: ['ssn'] });
    expect(csv).toContain('[REDACTED]');
    expect(csv).not.toContain('123-45-6789');
  });

  it('does not apply redaction when piiRedactFields is empty', () => {
    const rows = [makeRow()];
    const csv = formatExport(rows, 'csv', { piiRedactFields: [] });
    expect(csv).toContain('123-45-6789');
  });
});
