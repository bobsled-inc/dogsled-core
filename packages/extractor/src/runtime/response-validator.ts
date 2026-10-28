/**
 * Response validation — lint API responses against declared resource schema.
 *
 * Advisory warnings only — does not fail extraction.
 */

import type { ColumnType, ApiResourceSpec } from '../types/index.js';

export type ValidationIssueKind = 'extra_field' | 'type_mismatch' | 'unexpected_null';

export interface ValidationIssue {
  field: string;
  issue: ValidationIssueKind;
  count: number;
  sample?: unknown;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  recordsChecked: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECORDS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesType(value: unknown, type: ColumnType): boolean {
  if (value === null || value === undefined) return true; // nulls tracked separately
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'timestamp':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate raw records against the declared column schema.
 * Returns an aggregated report of issues found.
 *
 * API resources only — warehouse extraction has its own validation path
 * and `continue`s before this is called (see extract.ts extraction loop).
 */
export function validateRecords(
  rawRecords: unknown[],
  output: ApiResourceSpec['output']
): ValidationReport {
  const records = rawRecords.slice(0, MAX_RECORDS);
  const declaredNames = new Set(Object.keys(output));

  // Aggregation counters
  const extraFields = new Map<string, { count: number; sample: unknown }>();
  const typeMismatches = new Map<string, { count: number; sample: unknown }>();
  const unexpectedNulls = new Map<string, { count: number }>();

  for (const raw of records) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;

    // Check for extra fields not in schema
    for (const key of Object.keys(record)) {
      if (!declaredNames.has(key)) {
        const entry = extraFields.get(key);
        if (entry) {
          entry.count += 1;
        } else {
          extraFields.set(key, { count: 1, sample: record[key] });
        }
      }
    }

    // Check declared columns for type mismatches and unexpected nulls
    for (const [name, field] of Object.entries(output)) {
      if (field.from) continue;
      const value = record[name];

      if (value === null || value === undefined) {
        const entry = unexpectedNulls.get(name);
        if (entry) {
          entry.count += 1;
        } else {
          unexpectedNulls.set(name, { count: 1 });
        }
        continue;
      }

      if (!matchesType(value, field.type)) {
        const entry = typeMismatches.get(name);
        if (entry) {
          entry.count += 1;
        } else {
          typeMismatches.set(name, { count: 1, sample: value });
        }
      }
    }
  }

  // Build issue list
  const issues: ValidationIssue[] = [];

  for (const [field, { count, sample }] of extraFields) {
    issues.push({ field, issue: 'extra_field', count, sample });
  }
  for (const [field, { count, sample }] of typeMismatches) {
    issues.push({ field, issue: 'type_mismatch', count, sample });
  }
  for (const [field, { count }] of unexpectedNulls) {
    issues.push({ field, issue: 'unexpected_null', count });
  }

  return { issues, recordsChecked: records.length };
}
