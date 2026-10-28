import type { Readable, Writable } from 'node:stream';

import { buildClusterColumns, resolvePartitionColumn } from '../runtime/destinations/database.js';
import { sanitizeTableName } from '../runtime/destinations/database.js';
import { readProtocol } from '../runtime/protocol-reader.js';
import { validateDistinctStreamTables } from './stream-overrides.js';

import { CommandError } from '@bobsled-inc/protocol';
import type { LoadStrategy, SchemaBehavior } from '@bobsled-inc/protocol';

export interface RunDryRunOptions {
  /** Retained for callers that share options with the database loader. */
  destination?: string;
  /** Retained for callers that share options with the database loader. */
  schemaBehavior?: SchemaBehavior;
  loadStrategy?: LoadStrategy;
  streamLoadStrategy?: Record<string, LoadStrategy>;
  streamTable?: Record<string, string>;
  tablePrefix?: string;
  reconcileSchema?: string[];
}

async function writeLine(stream: Writable, line: string): Promise<void> {
  if (!stream.write(line)) {
    await new Promise<void>((resolve) => stream.once('drain', resolve));
  }
}

export async function runDryRun(
  options: RunDryRunOptions,
  dependencies: { input?: Readable; stderr?: Writable } = {}
): Promise<void> {
  const input = dependencies.input ?? process.stdin;
  const stderr = dependencies.stderr ?? process.stderr;
  const cliStrategy = options.loadStrategy;
  const streamStrategyOverrides = options.streamLoadStrategy ?? {};
  const streamTableOverrides = options.streamTable ?? {};
  const tablePrefix = options.tablePrefix ?? '';
  const reconcileSchemaStreams = new Set(options.reconcileSchema ?? []);
  const resolveTable = (stream: string): string =>
    sanitizeTableName(streamTableOverrides[stream] ?? `${tablePrefix}${stream}`);
  validateDistinctStreamTables(streamTableOverrides, resolveTable);

  const streams: Array<{
    stream: string;
    strategy: string;
    keys: string[];
    cursor: string;
    partition: string;
    cluster: string[];
  }> = [];
  const seenStreams = new Set<string>();

  for await (const message of readProtocol(input)) {
    if (message.type === 'SCHEMA') {
      seenStreams.add(message.stream);
      const effectiveStrategy =
        streamStrategyOverrides[message.stream] ?? cliStrategy ?? message.load_strategy;
      if (reconcileSchemaStreams.has(message.stream) && effectiveStrategy !== 'full_refresh') {
        throw new CommandError(
          `--reconcile-schema stream "${message.stream}" requires effective load strategy "full_refresh".`,
          2
        );
      }
      const clusterCols = buildClusterColumns(message.schema.columns, {
        keyProperties: message.key_properties,
        cursorField: message.cursor_field,
      });
      const partitionCol = resolvePartitionColumn(message.schema.columns, {
        partitionBy: message.partition_by,
        cursorField: message.cursor_field,
      });
      streams.push({
        stream: resolveTable(message.stream),
        strategy: effectiveStrategy,
        keys: message.key_properties,
        cursor: message.cursor_field ?? '—',
        partition: partitionCol,
        cluster: clusterCols,
      });
    }
  }

  const missingStreams = [...reconcileSchemaStreams].filter((stream) => !seenStreams.has(stream));
  if (missingStreams.length > 0) {
    throw new CommandError(
      `--reconcile-schema stream(s) not found in input: ${missingStreams.join(', ')}`,
      2
    );
  }

  if (streams.length === 0) {
    await writeLine(stderr, 'No SCHEMA messages found in input.\n');
    return;
  }

  const header = `${'Stream'.padEnd(20)} ${'Strategy'.padEnd(15)} ${'Keys'.padEnd(20)} ${'Cursor'.padEnd(15)} ${'Partition'.padEnd(18)} Cluster`;
  await writeLine(stderr, `${header}\n`);
  for (const stream of streams) {
    const line = `${stream.stream.padEnd(20)} ${stream.strategy.padEnd(15)} ${JSON.stringify(stream.keys).padEnd(20)} ${stream.cursor.padEnd(15)} ${stream.partition.padEnd(18)} ${JSON.stringify(stream.cluster)}`;
    await writeLine(stderr, `${line}\n`);
  }

  for (const stream of streams) {
    if (stream.strategy === 'merge' && stream.keys.length === 0) {
      await writeLine(
        stderr,
        `⚠ ${stream.stream}: merge strategy requires key_properties — will fall back to append\n`
      );
    }
  }
}
