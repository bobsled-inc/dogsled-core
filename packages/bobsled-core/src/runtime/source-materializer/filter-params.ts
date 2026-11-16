import { CommandError } from '@bobsled-inc/protocol';

import type { ApiResourceEntry } from './load-specs.js';

export type SourceFilterParamValue = string | number | boolean;

export interface SourceFilterRuntimeContext {
  params?: Record<string, SourceFilterParamValue>;
  session?: Record<string, SourceFilterParamValue>;
}

type SourceFilterParamsInput =
  SourceFilterRuntimeContext | Record<string, SourceFilterParamValue> | undefined;

const PARAM_TEMPLATE_RE = /^\s*\$\{\{\s*(params|session)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

function resolveValue(value: unknown, context: SourceFilterRuntimeContext): unknown {
  if (typeof value === 'string') {
    const match = value.match(PARAM_TEMPLATE_RE);
    if (!match) return value;
    const namespace = match[1] as 'params' | 'session';
    const name = match[2]!;
    const bag = namespace === 'session' ? context.session : context.params;
    if (!bag || !Object.hasOwn(bag, name)) {
      throw new CommandError(
        `source.filter references missing runtime ${namespace} parameter "${name}"`,
        2
      );
    }
    const resolved = bag[name];
    if (resolved === undefined) {
      throw new CommandError(
        `source.filter references missing runtime ${namespace} parameter "${name}"`,
        2
      );
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = resolveValue(nested, context);
  }
  return out;
}

function normalizeContext(input: SourceFilterParamsInput): SourceFilterRuntimeContext {
  if (!input) return {};
  if ('params' in input || 'session' in input) {
    return input as SourceFilterRuntimeContext;
  }
  return { params: input as Record<string, SourceFilterParamValue> };
}

export function applySourceFilterParams(
  entries: ApiResourceEntry[],
  input?: SourceFilterParamsInput
): ApiResourceEntry[] {
  const context = normalizeContext(input);

  return entries.map((entry) => {
    if (!entry.filter) return entry;
    return {
      ...entry,
      filter: resolveValue(entry.filter, context) as Record<string, unknown>,
    };
  });
}
