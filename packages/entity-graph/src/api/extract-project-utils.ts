import * as fs from 'node:fs';
import * as path from 'node:path';

import { generateStructured, resolveModelConnection } from '@bobsled-inc/ai';
import { PlatformConfigSchema, type PlatformConfig } from '@bobsled-inc/connections';
import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';
import YAML from 'yaml';
import { z } from 'zod';

import type { ExtractChunkInput } from '../runtime/mention/extract-chunk.js';
import type { LlmCall } from '../runtime/mention/extract.js';
import {
  proposeSurfaces,
  SurfaceProposalResponseSchema,
  type SurfaceProposalCall,
} from '../runtime/mention/surface-proposer.js';
import type { RelationshipLlmCall } from '../runtime/relationship/llm-extractor.js';
import { ROOT_CONFIG_FILE_SPELLINGS } from './legacy-names.js';

export type FallbackMode = 'compromise' | 'none';

export interface QueryableRunner {
  run(sql: string): Promise<unknown>;
  query?: (sql: string) => Promise<Array<Record<string, unknown>>>;
}

export interface ChunkRecord extends ExtractChunkInput {
  document_format?: string;
}

export interface PlatformResolution {
  platform?: PlatformConfig;
  projectKey: string;
}

const MentionResolutionSchema = z
  .object({
    resolved_entity_id: z.string(),
    confidence: z.number(),
  })
  .strict();

const RelationshipExtractionResponseSchema = z
  .object({
    extractions: z
      .array(
        z
          .object({
            relation_type: z.string(),
            left_entity_id: z.string(),
            right_entity_id: z.string(),
            span_start: z.number().int().optional(),
            span_end: z.number().int().optional(),
            evidence_excerpt: z.string().optional(),
            confidence: z.number(),
          })
          .strict()
      )
      .default([]),
  })
  .strict();

export function normalizeFallbackMode(value: string | undefined): FallbackMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'compromise' || value === 'none') return value;
  throw new CommandError(
    `Unsupported fallback mode '${value}'. Expected 'compromise' or 'none'.`,
    2
  );
}

export function requireQuery(
  runner: QueryableRunner,
  label: string
): NonNullable<QueryableRunner['query']> {
  if (!runner.query) {
    throw new CommandError(`${label} requires a runner that exports query(sql).`, 2);
  }
  return runner.query.bind(runner);
}

export function readField(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  const lower = name.toLowerCase();
  const entry = Object.entries(row).find(([key]) => key.toLowerCase() === lower);
  return entry?.[1];
}

export function readString(row: Record<string, unknown>, name: string): string | undefined {
  const value = readField(row, name);
  if (value === null || value === undefined) return undefined;
  return String(value);
}

export function readNumber(row: Record<string, unknown>, name: string): number | undefined {
  const value = readField(row, name);
  if (value === null || value === undefined) return undefined;
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function requiredString(row: Record<string, unknown>, name: string, source: string): string {
  const value = readString(row, name);
  if (value === undefined || value.length === 0) {
    throw new CommandError(`${source} row is missing required column '${name}'.`, 1);
  }
  return value;
}

function findDogsledConfig(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    for (const name of new Set(['dogsled.yml', 'dogsled.yaml', ...ROOT_CONFIG_FILE_SPELLINGS])) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function formatPlatformIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  platform.${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
}

export function loadPlatformResolution(cwd: string): PlatformResolution {
  const configPath = findDogsledConfig(cwd);
  if (!configPath) return { projectKey: path.resolve(cwd) };
  const raw = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  const platformRaw =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['platform']
      : undefined;
  if (platformRaw === undefined || platformRaw === null) {
    return { projectKey: path.resolve(configPath) };
  }
  const parsed = PlatformConfigSchema.safeParse(platformRaw);
  if (!parsed.success) {
    throw new CommandError(
      `Invalid dogsled.yml platform block:\n${formatPlatformIssues(parsed.error)}`,
      2
    );
  }
  return { platform: parsed.data, projectKey: path.resolve(configPath) };
}

export async function createAiMentionLlmCall(
  role: string,
  cwd: string
): Promise<LlmCall | undefined> {
  const resolution = loadPlatformResolution(cwd);
  if (!resolution.platform?.models?.[role]) return undefined;
  const connection = resolveModelConnection(role, { platform: resolution.platform });
  return (prompt) =>
    generateStructured(
      connection,
      {
        schema: MentionResolutionSchema,
        prompt: prompt.user,
        system: prompt.system,
      },
      {
        platform: resolution.platform,
        projectKey: resolution.projectKey,
      }
    );
}

export async function createAiSurfaceProposer(
  role: string,
  cwd: string
): Promise<SurfaceProposalCall | undefined> {
  const resolution = loadPlatformResolution(cwd);
  if (!resolution.platform?.models?.[role]) return undefined;
  const connection = resolveModelConnection(role, { platform: resolution.platform });
  return (input) =>
    proposeSurfaces(input, (prompt) =>
      generateStructured(
        connection,
        {
          schema: SurfaceProposalResponseSchema,
          prompt: prompt.user,
          system: prompt.system,
        },
        {
          platform: resolution.platform,
          projectKey: resolution.projectKey,
        }
      )
    );
}

export async function createAiRelationshipLlmCall(
  role: string,
  cwd: string
): Promise<RelationshipLlmCall | undefined> {
  const resolution = loadPlatformResolution(cwd);
  if (!resolution.platform?.models?.[role]) return undefined;
  const connection = resolveModelConnection(role, { platform: resolution.platform });
  return async (prompt) => {
    const result = await generateStructured(
      connection,
      {
        schema: RelationshipExtractionResponseSchema,
        prompt: prompt.user,
        system: prompt.system,
      },
      {
        platform: resolution.platform,
        projectKey: resolution.projectKey,
      }
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: result.value,
      model_id: connection.model,
      model_metadata: { cost_usd: result.costUsd, token_usage: result.tokenUsage },
    };
  };
}

export function sqlValue(value: unknown, dialect: SupportedDialect): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  // Delegate to model-spec's canonical, dialect-aware literal escaping. BigQuery
  // rejects '' quote-doubling ("concatenated string literals must be separated by
  // whitespace or comments") and needs \' plus escaped control chars; quoteLiteral
  // handles every dialect correctly. The old hand-rolled '' escaper broke
  // extract_mentions / extract_relationships on BigQuery for any entity_name or
  // evidence_excerpt containing an apostrophe.
  return quoteLiteral(String(value), dialect);
}

function assertQuotedTableName(table: string, dialect: SupportedDialect): string {
  const quotedIdentifier =
    dialect === 'bigquery' || dialect === 'databricks' || dialect === 'mysql'
      ? '`(?:[^`]|``)+`'
      : '"(?:[^"]|"")+"';
  const qualifiedTablePattern = new RegExp(`^${quotedIdentifier}(\\.${quotedIdentifier}){1,2}$`);
  if (qualifiedTablePattern.test(table)) return table;
  throw new CommandError(
    'insertRows requires a quoted schema-qualified table name built by buildFqName().',
    2
  );
}

export async function insertRows(
  runner: QueryableRunner,
  table: string,
  columns: readonly string[],
  rows: readonly object[],
  dialect: SupportedDialect
): Promise<void> {
  if (rows.length === 0) return;
  const tableSql = assertQuotedTableName(table, dialect);
  const columnSql = columns.map((column) => quoteIdentifier(column, dialect)).join(', ');
  const valuesSql = rows
    .map(
      (row) =>
        `(${columns
          .map((column) => sqlValue((row as Record<string, unknown>)[column], dialect))
          .join(', ')})`
    )
    .join(',\n');
  await runner.run(`INSERT INTO ${tableSql} (${columnSql}) VALUES ${valuesSql}`);
}

export async function readChunks(
  runner: QueryableRunner,
  schema: string,
  dialect: SupportedDialect
): Promise<ChunkRecord[]> {
  const query = requireQuery(runner, 'mention extraction');
  const table = buildFqName(schema, '__chunks', dialect);
  const rows = await query(
    `SELECT * FROM ${table} ORDER BY ${quoteIdentifier('chunk_id', dialect)}`
  );
  return rows.map((row) => {
    const chunkText = readString(row, 'chunk_text') ?? readString(row, 'text');
    if (!chunkText) {
      throw new CommandError(`__chunks row is missing required column 'chunk_text' or 'text'.`, 1);
    }
    const out: ChunkRecord = {
      chunk_id: requiredString(row, 'chunk_id', '__chunks'),
      chunk_text: chunkText,
      document_id: requiredString(row, 'document_id', '__chunks'),
      document_version_id: requiredString(row, 'document_version_id', '__chunks'),
    };
    const documentFormat = readString(row, 'document_format') ?? readString(row, 'format');
    if (documentFormat !== undefined) out.document_format = documentFormat;
    return out;
  });
}

export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new CommandError(`concurrency must be a positive integer; got ${concurrency}.`, 2);
  }
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(items[index]!, index);
      }
    })
  );
  return results;
}
