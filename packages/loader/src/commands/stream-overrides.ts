import {
  CommandError,
  LOAD_STRATEGIES,
  LOAD_STRATEGY_SET,
  SCHEMA_BEHAVIORS,
  SCHEMA_BEHAVIOR_SET,
} from '@bobsled-inc/protocol';
import {
  RESERVED_TABLE_PREFIX,
  SQL_IDENTIFIER_PATTERN,
  usesReservedTablePrefix,
} from '../runtime/identifiers.js';
import { Option } from 'commander';

import type { LoadStrategy, SchemaBehavior } from '@bobsled-inc/protocol';

/**
 * Per-stream override flags (`--stream-load-strategy`, `--stream-schema-behavior`,
 * `--stream-table`, `--stream-table-ownership-marker`) use
 * the same colon-delimited `<stream>:<value>` wire format as the extractor's
 * `--resource-via`. Both value spaces are closed enough for that to be safe:
 * load strategies are a fixed enum, and table names must be plain SQL
 * identifiers — neither can contain a colon. Stream names are extractor
 * resource names, which are snake_case by schema, so the FIRST colon is
 * always the separator.
 *
 * These flags are public CLI surface: `dogsled load run` is invokable
 * standalone, so every pair is validated here at the subprocess boundary even
 * though Dogsled already validates `bobsled.yml` before spawning the loader.
 */
function splitPair(flag: string, shape: string, value: string): { stream: string; rest: string } {
  const colon = value.indexOf(':');
  if (colon <= 0) {
    throw new CommandError(`${flag} expected "${shape}", got "${value}".`, 2);
  }
  const stream = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (stream.length === 0 || rest.length === 0) {
    throw new CommandError(`${flag} expected "${shape}", got "${value}".`, 2);
  }
  return { stream, rest };
}

/** Parse one `--stream-load-strategy <stream>:<strategy>` pair. */
export function parseStreamLoadStrategyPair(value: string): {
  stream: string;
  strategy: LoadStrategy;
} {
  const { stream, rest } = splitPair(
    '--stream-load-strategy',
    '<stream>:<append|merge|full_refresh>',
    value
  );
  if (!LOAD_STRATEGY_SET.has(rest)) {
    throw new CommandError(
      `--stream-load-strategy "${value}": invalid load strategy "${rest}". ` +
        `Must be one of: ${LOAD_STRATEGIES.join(', ')}.`,
      2
    );
  }
  return { stream, strategy: rest as LoadStrategy };
}

/** Parse one `--stream-table <stream>:<table>` pair. */
export function parseStreamTablePair(value: string): { stream: string; table: string } {
  const { stream, rest } = splitPair('--stream-table', '<stream>:<table>', value);
  if (!SQL_IDENTIFIER_PATTERN.test(rest)) {
    throw new CommandError(
      `--stream-table "${value}": invalid table name "${rest}". Must start with a letter or ` +
        `underscore, followed only by letters, digits, or underscores.`,
      2
    );
  }
  if (usesReservedTablePrefix(rest)) {
    throw new CommandError(
      `--stream-table "${value}": table name "${rest}" uses the reserved staging prefix ` +
        `"${RESERVED_TABLE_PREFIX}".`,
      2
    );
  }
  return { stream, table: rest };
}

/** Commander accumulator for repeatable `--stream-load-strategy` flags. */
export function collectStreamLoadStrategy(
  value: string,
  previous: Record<string, LoadStrategy>
): Record<string, LoadStrategy> {
  const { stream, strategy } = parseStreamLoadStrategyPair(value);
  return { ...previous, [stream]: strategy };
}

/** Build the repeatable per-stream load-strategy Commander option. */
export function createStreamLoadStrategyOption(): Option {
  return new Option(
    '--stream-load-strategy <stream:strategy...>',
    'Load strategy for one stream (repeatable). Wins over --load-strategy and the SCHEMA message.'
  )
    .argParser(collectStreamLoadStrategy)
    .default({} as Record<string, LoadStrategy>);
}

/** Parse one `--stream-schema-behavior <stream:mode>` pair. */
export function parseStreamSchemaBehaviorPair(value: string): {
  stream: string;
  schemaBehavior: SchemaBehavior;
} {
  const { stream, rest } = splitPair(
    '--stream-schema-behavior',
    '<stream>:<evolve|strict|freeze>',
    value
  );
  if (!SCHEMA_BEHAVIOR_SET.has(rest)) {
    throw new CommandError(
      `--stream-schema-behavior "${value}": invalid schema behavior "${rest}". ` +
        `Must be one of: ${SCHEMA_BEHAVIORS.join(', ')}.`,
      2
    );
  }
  return { stream, schemaBehavior: rest as SchemaBehavior };
}

/** Commander accumulator for repeatable `--stream-schema-behavior` flags. */
export function collectStreamSchemaBehavior(
  value: string,
  previous: Record<string, SchemaBehavior>
): Record<string, SchemaBehavior> {
  const { stream, schemaBehavior } = parseStreamSchemaBehaviorPair(value);
  return { ...previous, [stream]: schemaBehavior };
}

/** Build the repeatable per-stream schema-behavior Commander option. */
export function createStreamSchemaBehaviorOption(): Option {
  return new Option(
    '--stream-schema-behavior <stream:mode...>',
    'Schema contract behavior for one stream (repeatable). Wins over --schema-behavior and the SCHEMA message.'
  )
    .argParser(collectStreamSchemaBehavior)
    .default({} as Record<string, SchemaBehavior>);
}

/** Commander accumulator for repeatable `--stream-table` flags. */
export function collectStreamTable(
  value: string,
  previous: Record<string, string>
): Record<string, string> {
  const { stream, table } = parseStreamTablePair(value);
  return { ...previous, [stream]: table };
}

/** Build the repeatable per-stream destination-table Commander option. */
export function createStreamTableOption(): Option {
  return new Option(
    '--stream-table <stream:table...>',
    'Destination table name for one stream (repeatable). Replaces --table-prefix + stream entirely.'
  )
    .argParser(collectStreamTable)
    .default({} as Record<string, string>);
}

/** Parse one `--stream-table-ownership-marker <stream>:<marker>` pair. */
export function parseStreamTableOwnershipMarkerPair(value: string): {
  stream: string;
  marker: string;
} {
  const { stream, rest } = splitPair('--stream-table-ownership-marker', '<stream>:<marker>', value);
  if (rest.length > 256) {
    throw new CommandError(
      `--stream-table-ownership-marker "${value}": marker must be at most 256 characters.`,
      2
    );
  }
  if (rest.trim() !== rest || /[\u0000-\u001f\u007f]/.test(rest)) {
    throw new CommandError(
      `--stream-table-ownership-marker "${value}": marker must not contain surrounding whitespace or control characters.`,
      2
    );
  }
  return { stream, marker: rest };
}

/** Commander accumulator for repeatable table-ownership-marker options. */
export function collectStreamTableOwnershipMarker(
  value: string,
  previous: Record<string, string>
): Record<string, string> {
  const { stream, marker } = parseStreamTableOwnershipMarkerPair(value);
  return { ...previous, [stream]: marker };
}

/** Build the repeatable per-stream ownership-marker Commander option. */
export function createStreamTableOwnershipMarkerOption(): Option {
  return new Option(
    '--stream-table-ownership-marker <stream:marker...>',
    'Ownership marker for one reserved Snowflake table (repeatable).'
  )
    .argParser(collectStreamTableOwnershipMarker)
    .default({} as Record<string, string>);
}

/** Commander accumulator for repeatable `--reconcile-schema` stream names. */
export function collectReconcileSchema(value: string | string[], previous: string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  const next = [...previous];
  for (const rawStream of values) {
    const stream = rawStream.trim();
    if (!SQL_IDENTIFIER_PATTERN.test(stream)) {
      throw new CommandError(
        `--reconcile-schema "${rawStream}": invalid stream name. ` +
          'Use only letters, digits, and underscores, starting with a letter or underscore.',
        2
      );
    }
    if (!next.includes(stream)) {
      next.push(stream);
    }
  }
  return next;
}

/**
 * Build the raw-stream → table-key map used to resolve destination table
 * names, and the table-key → strategy map used to resolve load strategies.
 *
 * Both maps are keyed the way the rest of the database loader keys its
 * per-stream state: by the FINAL table name (prefixed + sanitized, or the
 * explicit `table:` override). Two streams that resolve to the same table but
 * demand different strategies are ambiguous, so that fails loud instead of
 * letting message order decide.
 */
export function resolveStreamStrategyOverrides(
  streamLoadStrategies: Record<string, LoadStrategy> | undefined,
  resolveTableKey: (stream: string) => string
): Map<string, LoadStrategy> {
  const resolved = new Map<string, LoadStrategy>();
  const sources = new Map<string, string>();
  for (const [stream, strategy] of Object.entries(streamLoadStrategies ?? {})) {
    const key = resolveTableKey(stream);
    const existing = resolved.get(key);
    if (existing !== undefined && existing !== strategy) {
      throw new CommandError(
        `Conflicting per-stream load strategies for table "${key}": ` +
          `"${sources.get(key)}" requests "${existing}" but "${stream}" requests "${strategy}".`,
        2
      );
    }
    resolved.set(key, strategy);
    sources.set(key, stream);
  }
  return resolved;
}

/**
 * Resolve raw-stream schema-behavior overrides to final destination table keys.
 * This mirrors strategy resolution so table overrides and prefixes remain
 * consistent across all per-stream loader state.
 */
export function resolveStreamSchemaBehaviorOverrides(
  streamSchemaBehaviors: Record<string, SchemaBehavior> | undefined,
  resolveTableKey: (stream: string) => string
): Map<string, SchemaBehavior> {
  const resolved = new Map<string, SchemaBehavior>();
  const sources = new Map<string, string>();
  for (const [stream, schemaBehavior] of Object.entries(streamSchemaBehaviors ?? {})) {
    const key = resolveTableKey(stream);
    const existing = resolved.get(key);
    if (existing !== undefined && existing !== schemaBehavior) {
      throw new CommandError(
        `Conflicting per-stream schema behaviors for table "${key}": ` +
          `"${sources.get(key)}" requests "${existing}" but "${stream}" requests "${schemaBehavior}".`,
        2
      );
    }
    resolved.set(key, schemaBehavior);
    sources.set(key, stream);
  }
  return resolved;
}

/**
 * Resolve raw-stream ownership-marker overrides to final destination table
 * keys so exact table overrides and table prefixes remain consistent with the
 * destination's per-stream state.
 */
export function resolveStreamTableOwnershipMarkerOverrides(
  streamTableOwnershipMarkers: Record<string, string> | undefined,
  resolveTableKey: (stream: string) => string
): Map<string, string> {
  const resolved = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const [stream, marker] of Object.entries(streamTableOwnershipMarkers ?? {})) {
    const key = resolveTableKey(stream);
    const existing = resolved.get(key);
    if (existing !== undefined && existing !== marker) {
      throw new CommandError(
        `Conflicting per-stream table ownership markers for table "${key}": ` +
          `"${sources.get(key)}" and "${stream}" reserve the same table with different markers.`,
        2
      );
    }
    resolved.set(key, marker);
    sources.set(key, stream);
  }
  return resolved;
}

/** Resolve all per-stream destination overrides using final table keys. */
export function resolveStreamDestinationOverrides(
  streamLoadStrategies: Record<string, LoadStrategy> | undefined,
  streamSchemaBehaviors: Record<string, SchemaBehavior> | undefined,
  streamTableOwnershipMarkers: Record<string, string> | undefined,
  resolveTableKey: (stream: string) => string
): {
  streamStrategyOverrides: Map<string, LoadStrategy>;
  streamSchemaBehaviorOverrides: Map<string, SchemaBehavior>;
  streamTableOwnershipMarkerOverrides: Map<string, string>;
} {
  return {
    streamStrategyOverrides: resolveStreamStrategyOverrides(streamLoadStrategies, resolveTableKey),
    streamSchemaBehaviorOverrides: resolveStreamSchemaBehaviorOverrides(
      streamSchemaBehaviors,
      resolveTableKey
    ),
    streamTableOwnershipMarkerOverrides: resolveStreamTableOwnershipMarkerOverrides(
      streamTableOwnershipMarkers,
      resolveTableKey
    ),
  };
}

export function validateDistinctStreamTables(
  streamTables: Record<string, string> | undefined,
  resolveTableKey: (stream: string) => string
): void {
  const owners = new Map<string, string>();
  for (const stream of Object.keys(streamTables ?? {})) {
    const table = resolveTableKey(stream);
    const owner = owners.get(table);
    if (owner && owner !== stream) {
      throw new CommandError(
        `Streams "${owner}" and "${stream}" both resolve to destination table "${table}". ` +
          'Give each stream a distinct --stream-table value.',
        2
      );
    }
    owners.set(table, stream);
  }
}
