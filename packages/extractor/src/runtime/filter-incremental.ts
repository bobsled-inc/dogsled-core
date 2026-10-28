import type { CursorKind } from '../constants.js';
import { compileQueryToMcpArgs } from './query/mcp-backend.js';
import { ExtractorConfigError } from './errors.js';
import type { ApiResourceSpec, QueryOperator } from '../types/index.js';

type FilterValueFormat = 'iso8601' | 'date' | 'unix_seconds' | 'unix_milliseconds';

type IncrementalConfig =
  | NonNullable<ApiResourceSpec['extract']['incremental']>
  | NonNullable<ApiResourceSpec['incremental']>;

type FilterIncrementalConfig = IncrementalConfig & {
  strategy: 'filter' | 'server_filter';
};

type CompileConfig = {
  mode?: unknown;
  param?: unknown;
  argument?: unknown;
};

type QueryFilterForIncremental = {
  compile: unknown;
  bind: Partial<Record<QueryOperator, { input: string }>>;
};

type ServerFilterInput = Record<string, Partial<Record<QueryOperator, string | number | boolean>>>;

export interface FilterWindow {
  params: Record<string, string | number | boolean>;
  upperBoundCursorValue: string;
}

const FILTER_LSN_UNSUPPORTED_ERROR =
  'filter incremental extraction does not support PostgreSQL LSN cursors';

function coerceToMillis(
  value: string,
  cursorKind: CursorKind,
  valueFormat: FilterValueFormat
): number {
  switch (cursorKind) {
    case 'timestamp': {
      const millis = new Date(value).getTime();
      if (Number.isNaN(millis)) {
        throw new Error(`Invalid timestamp cursor "${value}" for filter incremental extraction`);
      }
      return millis;
    }
    case 'integer':
    case 'number': {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid numeric cursor "${value}" for filter incremental extraction`);
      }
      return valueFormat === 'unix_seconds' ? numeric * 1000 : numeric;
    }
    case 'string': {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return valueFormat === 'unix_seconds' ? numeric * 1000 : numeric;
      }
      const millis = new Date(value).getTime();
      if (Number.isNaN(millis)) {
        throw new Error(`Invalid string cursor "${value}" for filter incremental extraction`);
      }
      return millis;
    }
    case 'lsn':
      throw new Error(FILTER_LSN_UNSUPPORTED_ERROR);
  }
}

function formatRequestValue(ms: number, valueFormat: FilterValueFormat): string | number {
  switch (valueFormat) {
    case 'iso8601':
      return new Date(ms).toISOString();
    case 'date':
      return new Date(ms).toISOString().slice(0, 10);
    case 'unix_seconds':
      return Math.floor(ms / 1000);
    case 'unix_milliseconds':
      return Math.floor(ms);
  }
}

function formatBookmarkValue(
  ms: number,
  cursorKind: CursorKind,
  valueFormat: FilterValueFormat
): string {
  switch (cursorKind) {
    case 'timestamp':
      // When value_format is 'date', store the bookmark as a date string so it
      // stays comparable with observed cursor values from the data (which are
      // also date-only strings parsed as timestamps).  Using a full ISO-8601
      // timestamp here would always "win" the maxCursor comparison against a
      // date-only value, causing the cursor to track wall-clock time instead of
      // data time.
      return valueFormat === 'date'
        ? new Date(ms).toISOString().slice(0, 10)
        : new Date(ms).toISOString();
    case 'integer':
      return String(valueFormat === 'unix_seconds' ? Math.floor(ms / 1000) : Math.floor(ms));
    case 'number':
      return String(valueFormat === 'unix_seconds' ? ms / 1000 : ms);
    case 'string':
      return String(formatRequestValue(ms, valueFormat));
    case 'lsn':
      throw new Error(FILTER_LSN_UNSUPPORTED_ERROR);
  }
}

export function getFilterIncrementalConfig(
  resource: ApiResourceSpec
): FilterIncrementalConfig | undefined {
  const incremental = getResourceIncrementalConfig(resource);
  if (
    !incremental ||
    (incremental.strategy !== 'filter' && incremental.strategy !== 'server_filter')
  ) {
    return undefined;
  }
  return incremental as FilterIncrementalConfig;
}

export function getResourceIncrementalConfig(
  resource: ApiResourceSpec
): IncrementalConfig | undefined {
  return resource.incremental ?? resource.extract.incremental;
}

export function getIncrementalCursorField(resource: ApiResourceSpec): string | undefined {
  const incremental = getResourceIncrementalConfig(resource);
  return incremental && 'cursor_field' in incremental ? incremental.cursor_field : undefined;
}

export function getIncrementalCursorType(resource: ApiResourceSpec): CursorKind | undefined {
  const incremental = getResourceIncrementalConfig(resource);
  return incremental && 'cursor_type' in incremental ? incremental.cursor_type : undefined;
}

export function inferCursorKindFromOutput(
  resource: ApiResourceSpec,
  cursorField: string | undefined
): CursorKind | undefined {
  if (!cursorField) {
    return undefined;
  }

  const outputType = resource.output[cursorField]?.type;
  switch (outputType) {
    case 'timestamp':
      return 'timestamp';
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    default:
      return undefined;
  }
}

export function compileServerFilterWindowParams(
  resource: ApiResourceSpec,
  config: FilterIncrementalConfig,
  params: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  if (config.strategy !== 'server_filter' || !resource.query || !config.cursor_field) {
    return params;
  }

  const filters = buildServerFilterInput(config, params);

  const compiled: Record<string, string | number | boolean> = {};
  const queryFilters = (resource.query.filters ?? {}) as Record<
    string,
    QueryFilterForIncremental | undefined
  >;

  for (const [field, operators] of Object.entries(filters)) {
    const filterSpec: QueryFilterForIncremental | undefined = queryFilters[field];
    if (!filterSpec) {
      throw new ExtractorConfigError(
        `server_filter incremental cursor field "${field}" is not declared in query.filters for resource "${resource.name}".`
      );
    }

    for (const [operator, value] of Object.entries(operators) as Array<
      [QueryOperator, string | number | boolean]
    >) {
      const compileConfig = getCompileConfigForOperator(filterSpec.compile, operator);
      const bindInput: string | undefined = filterSpec.bind[operator]?.input;
      if (compileConfig?.mode === 'http_query') {
        const target = typeof compileConfig.param === 'string' ? compileConfig.param : bindInput;
        if (target) compiled[target] = value;
      } else if (compileConfig?.mode === 'direct_arg') {
        const target =
          typeof compileConfig.argument === 'string' ? compileConfig.argument : bindInput;
        if (target) compiled[target] = value;
      } else if (bindInput) {
        compiled[bindInput] = value;
      }
    }
  }

  return compiled;
}

export function compileServerFilterMcpWindowParams(
  resource: ApiResourceSpec,
  config: FilterIncrementalConfig,
  params: Record<string, string | number | boolean>
): Record<string, unknown> {
  if (config.strategy !== 'server_filter' || !resource.query || !config.cursor_field) {
    return params;
  }

  const filters = buildServerFilterInput(config, params);
  if (Object.keys(filters).length === 0) {
    return params;
  }

  return compileQueryToMcpArgs({
    resource,
    filter: filters,
  });
}

function buildServerFilterInput(
  config: FilterIncrementalConfig,
  params: Record<string, string | number | boolean>
): ServerFilterInput {
  const filters: ServerFilterInput = {};
  const sinceArgument = config.since_argument ?? config.filter_argument;
  if (sinceArgument && params[sinceArgument] !== undefined) {
    filters[config.cursor_field] = {
      ...asOperatorObject(filters[config.cursor_field]),
      gte: params[sinceArgument],
    };
  }
  if (config.until_argument && params[config.until_argument] !== undefined) {
    filters[config.cursor_field] = {
      ...asOperatorObject(filters[config.cursor_field]),
      lte: params[config.until_argument],
    };
  }
  return filters;
}

function asOperatorObject(
  value: ServerFilterInput[string] | undefined
): Partial<Record<QueryOperator, string | number | boolean>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getCompileConfigForOperator(
  compile: unknown,
  operator: QueryOperator
): CompileConfig | undefined {
  if (!compile || typeof compile !== 'object' || Array.isArray(compile)) {
    return undefined;
  }
  const record = compile as Record<string, unknown>;
  if (typeof record['mode'] === 'string') {
    return record as CompileConfig;
  }
  const operatorConfig = record[operator];
  return operatorConfig && typeof operatorConfig === 'object' && !Array.isArray(operatorConfig)
    ? (operatorConfig as CompileConfig)
    : undefined;
}

export function buildFilterWindows(params: {
  config: FilterIncrementalConfig;
  cursorKind: CursorKind;
  existingBookmarkValue?: string;
  sinceOverride?: string;
  untilOverride?: string;
  now: Date;
}): FilterWindow[] {
  const { config, cursorKind, existingBookmarkValue, sinceOverride, untilOverride, now } = params;

  const valueFormat = config.value_format ?? 'iso8601';
  const sinceArgument = config.since_argument ?? config.filter_argument;
  if (!sinceArgument) {
    throw new Error('filter incremental config requires since_argument or filter_argument');
  }

  const nowMs = now.getTime();
  const untilMs = untilOverride ? coerceToMillis(untilOverride, cursorKind, valueFormat) : nowMs;

  let sinceMs: number;
  if (sinceOverride) {
    sinceMs = coerceToMillis(sinceOverride, cursorKind, valueFormat);
  } else if (existingBookmarkValue) {
    const bookmarkMs = coerceToMillis(existingBookmarkValue, cursorKind, valueFormat);
    sinceMs = Math.max(0, bookmarkMs - (config.lookback_seconds ?? 0) * 1000);
  } else {
    if (config.initial_lookback_seconds === undefined) {
      throw new Error(
        'filter incremental config requires initial_lookback_seconds when no bookmark exists'
      );
    }
    sinceMs = Math.max(0, nowMs - config.initial_lookback_seconds * 1000);
  }

  if (sinceMs > untilMs) {
    sinceMs = untilMs;
  }

  const windowSizeMs = config.window_size_seconds ? config.window_size_seconds * 1000 : undefined;
  if (!windowSizeMs || windowSizeMs <= 0) {
    return [
      {
        params: {
          [sinceArgument]: formatRequestValue(sinceMs, valueFormat),
          ...(config.until_argument
            ? { [config.until_argument]: formatRequestValue(untilMs, valueFormat) }
            : {}),
        },
        upperBoundCursorValue: formatBookmarkValue(untilMs, cursorKind, valueFormat),
      },
    ];
  }

  const windows: FilterWindow[] = [];
  let windowStart = sinceMs;
  while (windowStart < untilMs) {
    const windowEnd = Math.min(windowStart + windowSizeMs, untilMs);
    windows.push({
      params: {
        [sinceArgument]: formatRequestValue(windowStart, valueFormat),
        ...(config.until_argument
          ? { [config.until_argument]: formatRequestValue(windowEnd, valueFormat) }
          : {}),
      },
      upperBoundCursorValue: formatBookmarkValue(windowEnd, cursorKind, valueFormat),
    });
    if (windowEnd === untilMs) {
      break;
    }
    windowStart = windowEnd;
  }

  if (windows.length === 0) {
    windows.push({
      params: {
        [sinceArgument]: formatRequestValue(sinceMs, valueFormat),
        ...(config.until_argument
          ? { [config.until_argument]: formatRequestValue(untilMs, valueFormat) }
          : {}),
      },
      upperBoundCursorValue: formatBookmarkValue(untilMs, cursorKind, valueFormat),
    });
  }

  return windows;
}
