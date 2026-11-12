import { getFormatDef, type OutputFormat } from './formats.js';
import {
  allRows,
  closeDuckDbResources,
  escapeSqlString,
  mapDuckDbType,
  openDuckDb,
  quoteDuckDbTypeLiteral,
  quoteIdentifier,
  runStatement,
} from './duckdb-primitives.js';

import type { BatchEncoding, SchemaColumn } from '@bobsled-inc/protocol';
import type { DuckDbConnectionLike, DuckDbDatabaseLike } from './duckdb-primitives.js';

export interface ConvertFileOptions {
  sourcePath: string;
  outputPath: string;
  format: OutputFormat;
  sourceEncoding?: BatchEncoding;
  columns?: SchemaColumn[];
  /**
   * Write timestamp columns as UTC-adjusted (`TIMESTAMPTZ`). Parquet output only.
   * The instants stay the same; only the Parquet logical type changes.
   */
  utcTimestamps?: boolean;
}

export interface DuckDbWriter {
  convertFile(options: ConvertFileOptions): Promise<void>;
  close(): Promise<void>;
}

export interface CreateDuckDbWriterOptions {
  databaseFactory?: () => Promise<DuckDbDatabaseLike>;
}

/**
 * Naive timestamp types that widen to `TIMESTAMPTZ` without losing digits.
 * `TIMESTAMP_NS` is left as written because `TIMESTAMPTZ` stops at microseconds.
 */
const NAIVE_TIMESTAMP_TYPES: ReadonlySet<string> = new Set([
  'TIMESTAMP',
  'TIMESTAMP_S',
  'TIMESTAMP_MS',
]);

function buildTypedJsonRelation(sourcePath: string, columns: SchemaColumn[]): string {
  const escapedPath = escapeSqlString(sourcePath);
  const typedColumns = columns.map(
    (column) => `${quoteIdentifier(column.name)}: ${quoteDuckDbTypeLiteral(mapDuckDbType(column))}`
  );
  return `read_json('${escapedPath}', format = 'newline_delimited', auto_detect = false, columns = {${typedColumns.join(', ')}})`;
}

function buildSourceQueryForEncoding(
  sourcePath: string,
  sourceEncoding: BatchEncoding,
  columns?: SchemaColumn[]
): string {
  if (sourceEncoding.format === 'parquet') {
    return `SELECT * FROM read_parquet('${escapeSqlString(sourcePath)}')`;
  }

  if (columns && columns.length > 0) {
    return `SELECT * FROM ${buildTypedJsonRelation(sourcePath, columns)}`;
  }

  return `SELECT * FROM read_json_auto('${escapeSqlString(sourcePath)}')`;
}

class DefaultDuckDbWriter implements DuckDbWriter {
  private readonly db: DuckDbDatabaseLike;
  private readonly conn: DuckDbConnectionLike;
  private readonly initializedFormats = new Set<string>();
  private utcTimeZoneSet = false;

  constructor(db: DuckDbDatabaseLike, conn: DuckDbConnectionLike) {
    this.db = db;
    this.conn = conn;
  }

  private async ensureFormatInit(format: OutputFormat): Promise<void> {
    if (this.initializedFormats.has(format)) {
      return;
    }

    const formatDef = getFormatDef(format);
    for (const statement of formatDef.initStatements ?? []) {
      await runStatement(this.conn, statement);
    }

    this.initializedFormats.add(format);
  }

  private async ensureUtcTimeZone(): Promise<void> {
    if (this.utcTimeZoneSet) {
      return;
    }

    await runStatement(this.conn, "SET TimeZone = 'UTC'");
    this.utcTimeZoneSet = true;
  }

  private async withUtcTimestamps(selectQuery: string): Promise<string> {
    await this.ensureUtcTimeZone();
    const described = await allRows(this.conn, `DESCRIBE ${selectQuery}`);
    const naive = described
      .filter((row) => NAIVE_TIMESTAMP_TYPES.has(String(row['column_type'])))
      .map((row) => quoteIdentifier(String(row['column_name'])));
    if (naive.length === 0) {
      return selectQuery;
    }

    const replacements = naive.map((name) => `CAST(${name} AS TIMESTAMPTZ) AS ${name}`);
    return `SELECT * REPLACE (${replacements.join(', ')}) FROM (${selectQuery})`;
  }

  async convertFile(options: ConvertFileOptions): Promise<void> {
    if (options.utcTimestamps === true && options.format !== 'parquet') {
      throw new Error('utcTimestamps applies to parquet output only');
    }

    await this.ensureFormatInit(options.format);

    const sourceQuery = buildSourceQueryForEncoding(
      options.sourcePath,
      options.sourceEncoding ?? { format: 'jsonl' },
      options.columns
    );
    const selectQuery =
      options.utcTimestamps === true ? await this.withUtcTimestamps(sourceQuery) : sourceQuery;
    const formatDef = getFormatDef(options.format);
    const copyOptions = [`FORMAT ${formatDef.duckdbCopyFormat}`];
    for (const option of formatDef.duckdbCopyOptions ?? []) {
      copyOptions.push(option);
    }

    const copySql =
      `COPY (${selectQuery}) TO '${escapeSqlString(options.outputPath)}' ` +
      `(${copyOptions.join(', ')})`;
    await runStatement(this.conn, copySql);
  }

  async close(): Promise<void> {
    await closeDuckDbResources(this.conn, this.db);
  }
}

export async function createDuckDbWriter(
  options: CreateDuckDbWriterOptions = {}
): Promise<DuckDbWriter> {
  const factory = options.databaseFactory ?? (() => openDuckDb(':memory:'));
  const db = await factory();
  const conn = await db.connect();
  return new DefaultDuckDbWriter(db, conn);
}
