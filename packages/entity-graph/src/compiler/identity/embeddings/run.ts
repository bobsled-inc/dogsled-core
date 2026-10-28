import { CommandError } from '@bobsled-inc/protocol';
import type { SqlQueryRow, SqlQueryRunner, SupportedDialect } from '@bobsled-inc/model-spec';

import type { ResolvedResolutionSpec } from '../types.js';
import {
  buildSemanticEmbeddingEstimateQuery,
  buildSemanticEmbeddingInputQuery,
} from '../codegen-semantic-triage.js';
import {
  createSemanticEmbeddingProvider,
  estimateEmbeddingCostUsd,
  estimateEmbeddingTokens,
  resolveSemanticEmbeddingProviderConfig,
} from './provider.js';
import { insertEmbeddingCacheRecords } from './cache.js';

type SqlRunner = ((sql: string) => Promise<{ rowCount?: number }>) & {
  logger?: { warn(message: string): void };
};

export interface SemanticTriageEmbeddingRunResult {
  skipped: boolean;
  reason?: string;
  semanticCandidateCount: number;
  missingInputCount: number;
  estimatedEmbeddingTokens: number;
  estimatedEmbeddingCostUsd: number;
  cacheInsertCount?: number;
}

function normalizeRow(row: SqlQueryRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
}

function parseEmbeddingInputRows(
  rows: SqlQueryRow[]
): Array<{ contentHash: string; text: string }> {
  const inputs: Array<{ contentHash: string; text: string }> = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const normalized = normalizeRow(row);
    const contentHash = normalized.content_hash;
    const inputText = normalized.input_text;
    if (typeof contentHash !== 'string' || typeof inputText !== 'string') {
      continue;
    }
    if (seen.has(contentHash)) {
      continue;
    }
    seen.add(contentHash);
    inputs.push({ contentHash, text: inputText });
  }

  return inputs;
}

function parseNumericStat(row: SqlQueryRow | undefined, key: string): number {
  if (!row) {
    return 0;
  }
  const normalized = normalizeRow(row);
  const value = normalized[key];
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

async function embedAndCache(
  inputs: Array<{ contentHash: string; text: string }>,
  options: {
    spec: ResolvedResolutionSpec;
    targetSchema: string;
    dialect: SupportedDialect;
    run: SqlRunner;
    env?: Record<string, string | undefined>;
  }
): Promise<number | undefined> {
  const triage = options.spec.semanticTriage;
  if (!triage || inputs.length === 0) {
    return 0;
  }

  const provider = await createSemanticEmbeddingProvider({
    triage,
    env: options.env,
  });
  let inserted = 0;
  let insertedCountKnown = true;

  for (let index = 0; index < inputs.length; index += 100) {
    const batch = inputs.slice(index, index + 100);
    const embedded = await provider.embed(batch.map((input) => input.text));
    if (!Array.isArray(embedded.vectors) || embedded.vectors.length !== batch.length) {
      throw new CommandError(
        `Embedding provider returned ${embedded.vectors.length} vectors for ${batch.length} inputs.`,
        2
      );
    }
    const records = batch.map((input, batchIndex) => {
      const vector = embedded.vectors[batchIndex];
      if (!vector) {
        throw new CommandError(
          `Missing embedding vector for content hash ${input.contentHash}.`,
          1
        );
      }
      return {
        contentHash: input.contentHash,
        provider: triage.provider,
        embedding: vector,
      };
    });
    const insertedCount = await insertEmbeddingCacheRecords(
      options.run,
      options.spec.entity,
      options.targetSchema,
      options.dialect,
      records
    );
    if (insertedCount === undefined) {
      insertedCountKnown = false;
      continue;
    }
    inserted += insertedCount;
  }

  return insertedCountKnown ? inserted : undefined;
}

export async function runSemanticTriageEmbeddingPrep(options: {
  spec: ResolvedResolutionSpec;
  targetSchema: string;
  dialect: SupportedDialect;
  run: SqlRunner;
  query?: SqlQueryRunner;
  env?: Record<string, string | undefined>;
}): Promise<SemanticTriageEmbeddingRunResult | null> {
  const triage = options.spec.semanticTriage;
  if (!triage) {
    return null;
  }

  if (!options.query) {
    return {
      skipped: true,
      reason: 'semantic triage requires a runner module with query(sql)',
      semanticCandidateCount: 0,
      missingInputCount: 0,
      estimatedEmbeddingTokens: 0,
      estimatedEmbeddingCostUsd: 0,
      cacheInsertCount: 0,
    };
  }

  const [statsRows, rows] = await Promise.all([
    options.query(
      buildSemanticEmbeddingEstimateQuery(options.spec, options.dialect, options.targetSchema, true)
    ),
    options.query(
      buildSemanticEmbeddingInputQuery(options.spec, options.dialect, options.targetSchema)
    ),
  ]);
  const statsRow = statsRows[0];
  const semanticCandidateCount = parseNumericStat(statsRow, 'semantic_candidate_count');
  const inputs = parseEmbeddingInputRows(rows);
  const estimatedEmbeddingTokens = inputs.reduce(
    (sum, input) => sum + estimateEmbeddingTokens(input.text),
    0
  );
  const providerConfig = resolveSemanticEmbeddingProviderConfig(triage);
  const estimatedEmbeddingCostUsd = estimateEmbeddingCostUsd(
    estimatedEmbeddingTokens,
    providerConfig
  );
  const maxCost = options.spec.agentPolicy?.maxEmbeddingCostUsd;

  if (maxCost !== undefined && estimatedEmbeddingCostUsd > maxCost) {
    return {
      skipped: true,
      reason: `semantic triage estimated embedding cost ${estimatedEmbeddingCostUsd.toFixed(6)} exceeds max_embedding_cost_usd=${maxCost}`,
      semanticCandidateCount,
      missingInputCount: inputs.length,
      estimatedEmbeddingTokens,
      estimatedEmbeddingCostUsd,
      cacheInsertCount: 0,
    };
  }

  const cacheInsertCount = await embedAndCache(inputs, options);

  return {
    skipped: false,
    semanticCandidateCount,
    missingInputCount: inputs.length,
    estimatedEmbeddingTokens,
    estimatedEmbeddingCostUsd,
    cacheInsertCount,
  };
}
