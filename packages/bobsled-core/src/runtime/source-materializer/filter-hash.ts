import { createHash } from 'node:crypto';

import { parseMaxAge } from './max-age.js';

const DEFAULT_RELATIVE_DATE_BUCKET_SECONDS = 60 * 60;
const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
} as const;

export interface FilterHashOptions {
  nowIso?: string;
  maxAge?: string;
}

/**
 * Named alias for the source filter boundary shape. Values are operator
 * expressions (`{ eq: 'x' }`), scalar literals, or nested records/arrays of the
 * same. Kept as `unknown`-valued because the filter DSL is polymorphic; use
 * `canonical()`/`applySqlWherePushdown` to interpret contents.
 */
export type SourceFilter = Record<string, unknown>;

interface CanonicalContext {
  bucketAnchorMs: number;
}

function bucketSeconds(maxAge: string | undefined): number {
  const maxAgeSec = parseMaxAge(maxAge);
  return Math.max(DEFAULT_RELATIVE_DATE_BUCKET_SECONDS, maxAgeSec ?? 0);
}

function bucketAnchorMs(options: FilterHashOptions): number {
  const nowMs = options.nowIso === undefined ? Date.now() : Date.parse(options.nowIso);
  const bucketMs = bucketSeconds(options.maxAge) * 1000;
  return Math.floor(nowMs / bucketMs) * bucketMs;
}

function parseRelativeDate(value: string, context: CanonicalContext): string | undefined {
  if (value === '@now') {
    return new Date(context.bucketAnchorMs).toISOString();
  }

  const match = /^(?:@now)?([+-])(\d+)(s|m|h|d)$/.exec(value);
  if (!match) return undefined;

  const sign = match[1] === '-' ? -1 : 1;
  const amount = Number(match[2]);
  const unit = match[3] as keyof typeof UNIT_SECONDS;
  const targetMs = context.bucketAnchorMs + sign * amount * UNIT_SECONDS[unit] * 1000;
  return new Date(targetMs).toISOString();
}

function canonical(value: unknown, context: CanonicalContext): unknown {
  if (typeof value === 'string') {
    return parseRelativeDate(value, context) ?? value;
  }
  if (value === null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, context));

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = canonical((value as Record<string, unknown>)[key], context);
  }
  return output;
}

export function filterHash(
  filter: SourceFilter | undefined,
  options: FilterHashOptions = {}
): string {
  // Query filters do not carry source/operator time granularity yet. Until that
  // metadata exists, all relative temporal values in one filter share a single
  // bucket anchored by max(default 1h, max_age).
  const context = { bucketAnchorMs: bucketAnchorMs(options) };
  const payload = filter && Object.keys(filter).length > 0 ? canonical(filter, context) : 'none';
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}
