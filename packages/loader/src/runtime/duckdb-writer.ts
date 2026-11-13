import { getFormatDef, type OutputFormat } from './formats.js';
import {
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
}

export interface DuckDbWriter {
  convertFile(options: ConvertFileOptions): Promise<void>;
  close(): Promise<void>;
}

export interface CreateDuckDbWriterOptions {
  databaseFactory?: () => Promise<DuckDbDatabaseLike>;
}

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

  async convertFile(options: ConvertFileOptions): Promise<void> {
    await this.ensureFormatInit(options.format);

    const selectQuery = buildSourceQueryForEncoding(
      options.sourcePath,
      options.sourceEncoding ?? { format: 'jsonl' },
      options.columns
    );
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
