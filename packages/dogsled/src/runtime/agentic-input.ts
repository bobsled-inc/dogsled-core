import type { AgenticColumn } from '@bobsled-inc/model-spec/agentic';

/** Convert driver scalar representations without changing their meaning. */
export function normalizeAgenticInputValue(value: unknown, type: AgenticColumn['type']): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) {
    return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  // DuckDB native timestamps store epoch units as bigint. Preserve the fraction
  // rather than passing through Date, which only retains milliseconds.
  if (type === 'timestamp' && typeof value === 'object') {
    for (const [field, scale, digits] of [
      ['nanos', 1_000_000_000n, 9],
      ['micros', 1_000_000n, 6],
      ['millis', 1_000n, 3],
      ['seconds', 1n, 0],
    ] as const) {
      const units = (value as Record<string, unknown>)[field];
      if (typeof units !== 'bigint') continue;
      const fraction = ((units % scale) + scale) % scale;
      const seconds = (units - fraction) / scale;
      const iso = new Date(Number(seconds) * 1000).toISOString();
      return `${iso.slice(0, -5)}${digits ? `.${String(fraction).padStart(digits, '0')}` : ''}Z`;
    }
  }
  if (
    type === 'date' &&
    typeof value === 'object' &&
    'days' in value &&
    typeof value.days === 'number' &&
    Number.isSafeInteger(value.days)
  ) {
    return new Date(value.days * 86_400_000).toISOString().slice(0, 10);
  }
  // BigQuery returns temporal values in small { value: string } wrappers.
  // Do not unwrap business objects, and do not guess a zone for DATETIME values.
  if (
    (type === 'date' || type === 'timestamp') &&
    typeof value === 'object' &&
    'value' in value &&
    typeof value.value === 'string' &&
    value.value.length <= 64
  ) {
    value = value.value;
  }
  if (type === 'timestamp' && typeof value === 'string') {
    const zoned =
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2}| UTC)$/.exec(value);
    if (zoned) return `${zoned[1]}T${zoned[2]}${zoned[3] === ' UTC' ? 'Z' : zoned[3]}`;
  }
  if (typeof value === 'bigint') return Number(value); // Row schema rejects unsafe integers.
  if ((type === 'array' || type === 'object') && typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (type === 'boolean' && (value === 0 || value === 1)) return value === 1;
  if (
    (type === 'integer' || type === 'number') &&
    typeof value === 'string' &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
  ) {
    return Number(value);
  }
  return value;
}
