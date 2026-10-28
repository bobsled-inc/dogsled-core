import { createHash } from 'node:crypto';

import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import { outputTableName } from '../../output-tables/index.js';
import type { SemanticEmbeddingProviderConfig } from './provider.js';

type SqlRunner = (sql: string) => Promise<{ rowCount?: number }>;

export interface SemanticEmbeddingCacheRecord {
  contentHash: string;
  provider: string;
  embedding: number[];
}

export function semanticCachePayload(
  input: string,
  provider: SemanticEmbeddingProviderConfig
): string {
  return [provider.id, provider.model, String(provider.dimensions), input].join('\u001f');
}

export function semanticContentHash(
  input: string,
  provider: SemanticEmbeddingProviderConfig
): string {
  return createHash('md5').update(semanticCachePayload(input, provider)).digest('hex');
}

function vectorLiteral(embedding: number[], dialect: SupportedDialect): string {
  switch (dialect) {
    case 'duckdb':
    case 'bigquery':
      return `[${embedding.map((value) => String(value)).join(', ')}]`;
    case 'postgres':
    case 'redshift':
    case 'pgvector':
      return `ARRAY[${embedding.map((value) => String(value)).join(', ')}]`;
    case 'snowflake':
      return `ARRAY_CONSTRUCT(${embedding.map((value) => String(value)).join(', ')})`;
    case 'databricks':
      return `array(${embedding.map((value) => String(value)).join(', ')})`;
    case 'mysql':
      return `JSON_ARRAY(${embedding.map((value) => String(value)).join(', ')})`;
    default:
      return `[${embedding.map((value) => String(value)).join(', ')}]`;
  }
}

export function buildEmbeddingCacheInsertSql(
  entity: string,
  targetSchema: string,
  dialect: SupportedDialect,
  records: SemanticEmbeddingCacheRecord[]
): string | null {
  if (records.length === 0) {
    return null;
  }

  const tableName = buildFqName(
    targetSchema,
    outputTableName(entity, '__embedding_cache'),
    dialect
  );
  const contentHash = quoteIdentifier('content_hash', dialect);
  const provider = quoteIdentifier('provider', dialect);
  const embedding = quoteIdentifier('embedding', dialect);
  const rows = records
    .map(
      (record) =>
        `SELECT ${quoteLiteral(record.contentHash, dialect)} AS ${contentHash}, ${quoteLiteral(record.provider, dialect)} AS ${provider}, ${vectorLiteral(record.embedding, dialect)} AS ${embedding}`
    )
    .join('\n  UNION ALL\n  ');

  return [
    `INSERT INTO ${tableName} (${contentHash}, ${provider}, ${embedding})`,
    `SELECT incoming.${contentHash}, incoming.${provider}, incoming.${embedding}`,
    `FROM (`,
    `  ${rows}`,
    `) incoming`,
    `WHERE NOT EXISTS (`,
    `  SELECT 1`,
    `  FROM ${tableName} existing`,
    `  WHERE existing.${contentHash} = incoming.${contentHash}`,
    `    AND existing.${provider} = incoming.${provider}`,
    `)`,
  ].join('\n');
}

export async function insertEmbeddingCacheRecords(
  run: SqlRunner,
  entity: string,
  targetSchema: string,
  dialect: SupportedDialect,
  records: SemanticEmbeddingCacheRecord[]
): Promise<number | undefined> {
  const sql = buildEmbeddingCacheInsertSql(entity, targetSchema, dialect, records);
  if (!sql) {
    return 0;
  }
  const result = await run(sql);
  return result.rowCount;
}
