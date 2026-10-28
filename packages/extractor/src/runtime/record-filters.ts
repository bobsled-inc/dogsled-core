import type { RecordFilter } from '../framework/extractor/record-filter.js';

interface CompiledRecordFilter {
  readonly field: string;
  readonly allowedValues: ReadonlySet<string>;
}

function toComparableString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    return undefined;
  }
  return String(value);
}

function buildAllowedValues(value: unknown, delimiter: string): Set<string> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  let rawValues: unknown[];
  if (Array.isArray(value)) {
    rawValues = value;
  } else if (typeof value === 'string' && value.trimStart().startsWith('[')) {
    try {
      const decoded = JSON.parse(value) as unknown;
      if (!Array.isArray(decoded)) return undefined;
      // An explicitly encoded empty array is a real, enabled filter that
      // matches no values. This differs from a missing/empty runtime array,
      // which retains the established pass-through semantics.
      if (decoded.length === 0) return new Set();
      rawValues = decoded;
    } catch {
      // A bracket-prefixed but non-JSON value is not a valid encoded array.
      // Do not create unusable tokens such as "[a" and "b]".
      return undefined;
    }
  } else {
    rawValues = String(value).split(delimiter);
  }
  const values = rawValues
    .map((entry) => toComparableString(entry)?.trim())
    .filter((entry): entry is string => entry !== undefined && entry.length > 0);
  return values.length > 0 ? new Set(values) : undefined;
}

/**
 * Bookkeeping for record_filters across a resource extraction. Pre-compiles
 * the allowed-values set once per resource (so the per-record inner loop is
 * O(1)), counts rejected records, and composes the empty-result warning so
 * the call site in extract.ts stays compact.
 */
export class RecordFilterTracker {
  private rejectedCount = 0;
  private constructor(
    private readonly declaredFilters: RecordFilter[],
    private readonly compiled: CompiledRecordFilter[]
  ) {}

  static from(
    filters: RecordFilter[] | undefined,
    input: Record<string, unknown>
  ): RecordFilterTracker {
    const declared = filters ?? [];
    const compiled: CompiledRecordFilter[] = [];
    for (const filter of declared) {
      // Filters whose input is missing or empty are dropped here — at runtime
      // they would unconditionally pass, so omitting them collapses `matches`
      // to a single `length === 0` check on the hot path.
      const allowedValues = buildAllowedValues(input[filter.input], filter.delimiter ?? ',');
      if (allowedValues) {
        compiled.push({ field: filter.field, allowedValues });
      }
    }
    return new RecordFilterTracker(declared, compiled);
  }

  /**
   * Returns true when the record passes every compiled filter. Increments the
   * internal rejected counter when it does not — used downstream to surface a
   * warning when the configuration produced an empty result set.
   */
  matches(record: Record<string, unknown>): boolean {
    if (this.compiled.length === 0) {
      return true;
    }
    for (const filter of this.compiled) {
      const value = toComparableString(record[filter.field]);
      if (value === undefined || !filter.allowedValues.has(value)) {
        this.rejectedCount += 1;
        return false;
      }
    }
    return true;
  }

  emptyResultWarning(resourceName: string, apiCalls: number, recordCount: number): string | null {
    if (this.declaredFilters.length === 0) return null;
    if (recordCount !== 0 || this.rejectedCount === 0 || apiCalls === 0) return null;
    const boundInputs = [...new Set(this.declaredFilters.map((filter) => filter.input))].join(', ');
    return (
      `Resource "${resourceName}" emitted 0 records: record_filters rejected ` +
      `${this.rejectedCount} records returned by the API. Check that the values ` +
      `supplied for the bound input fields (${boundInputs}) match the upstream ` +
      `output values.`
    );
  }
}
