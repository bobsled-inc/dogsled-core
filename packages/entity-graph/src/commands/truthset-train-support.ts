import YAML from 'yaml';
import { CommandError } from '@bobsled-inc/protocol';
import { ResolutionSpecSchema, type SupportedDialect } from '@bobsled-inc/model-spec';
import {
  readYamlDocument,
  serializeDocument,
  writeYamlDocument,
} from '@bobsled-inc/model-spec/edit';

import { discoverResolutionSpecs } from '../compiler/identity/parser.js';
import {
  buildDeterministicPriorAnchorQuery,
  buildLabeledLevelOutcomeQuery,
} from '../compiler/identity/codegen-fs-training.js';

import type { FellegiSunterScoring, ResolvedResolutionSpec } from '../compiler/identity/types.js';
import type { TruthsetLabel } from '../compiler/truthset/parser.js';
import type { LevelOutcome } from '../compiler/truthset/train.js';

export interface QueryRunner {
  query: (sql: string) => Promise<unknown> | unknown;
}

function toYamlScoring(scoring: FellegiSunterScoring): Record<string, unknown> {
  return {
    method: 'fellegi_sunter',
    prior: scoring.prior,
    comparisons: scoring.comparisons.map((comparison) => ({
      field: comparison.field,
      levels: comparison.levels.map((level) => ({
        op: level.op,
        ...(level.gte !== undefined ? { gte: level.gte } : {}),
        m: level.m,
        u: level.u,
      })),
    })),
  };
}

export function serializeFellegiSunterScoringPatch(scoring: FellegiSunterScoring): string {
  return YAML.stringify({ scoring: toYamlScoring(scoring) });
}

export function applyFellegiSunterScoringPatch(
  filePath: string,
  scoring: FellegiSunterScoring
): { file_path: string; content: string } {
  const read = readYamlDocument(filePath);
  if (!read.ok) {
    throw new CommandError(read.error, 2);
  }
  if (read.data.doc.errors.length > 0) {
    throw new CommandError(
      `Invalid YAML in ${filePath}: ${read.data.doc.errors.map((e) => e.message).join('; ')}`,
      2
    );
  }

  read.data.doc.set('scoring', toYamlScoring(scoring));
  const content = serializeDocument(read.data.doc);
  const validation = ResolutionSpecSchema.safeParse(YAML.parse(content));
  if (!validation.success) {
    const issue = validation.error.issues[0];
    throw new CommandError(
      `${filePath}: trained scoring block failed resolution validation at ${issue?.path.join('.')}: ${issue?.message ?? 'schema validation failed'}`,
      2
    );
  }

  const write = writeYamlDocument(filePath, content);
  if (!write.ok) {
    throw new CommandError(write.error, 1);
  }
  return { file_path: filePath, content };
}

export function assertFellegiSunterSpec(spec: ResolvedResolutionSpec): FellegiSunterScoring {
  if (spec.scoring?.method !== 'fellegi_sunter') {
    throw new CommandError(
      `truthset train requires resolution ${spec.name} to define scoring.method: fellegi_sunter as the comparison-level skeleton.`,
      2
    );
  }
  return spec.scoring;
}

function normalizeLevelOutcomeRows(
  rawRows: unknown,
  comparisons: FellegiSunterScoring['comparisons'],
  labelsByPair?: Map<string, TruthsetLabel['label']>,
  requirePairId = false
): LevelOutcome[] {
  if (!Array.isArray(rawRows)) {
    throw new CommandError('Runner query returned a non-array result for level outcomes.', 1);
  }

  const seenPairIds = requirePairId ? new Set<string>() : undefined;
  const outcomes = rawRows.map((row, rowIndex) => {
    if (!row || typeof row !== 'object') {
      throw new CommandError(`Runner level outcome row ${rowIndex} is not an object.`, 1);
    }
    const record = row as Record<string, unknown>;
    const rawPairId = record.pair_id;
    const pairId = rawPairId == null ? undefined : String(rawPairId);
    if (requirePairId && !pairId) {
      throw new CommandError(`Runner level outcome row ${rowIndex} is missing pair_id.`, 1);
    }

    const levels: Record<string, number> = {};
    comparisons.forEach((comparison, comparisonIndex) => {
      const rawLevel = record[`level_${comparisonIndex}`];
      const level = rawLevel == null ? -1 : Number(rawLevel);
      if (!Number.isFinite(level)) {
        throw new CommandError(
          `Runner level outcome row ${rowIndex} has non-numeric level_${comparisonIndex}.`,
          1
        );
      }
      levels[comparison.field] = Math.trunc(level);
    });

    return {
      ...(pairId ? { pair_id: pairId } : {}),
      ...(pairId && labelsByPair?.has(pairId) ? { label: labelsByPair.get(pairId) } : {}),
      levels,
    };
  });

  // A pair matching two or more deterministic rules appears once per rule in
  // __pair_scores (UNION ALL), so the labeled-outcome query returns it multiple
  // times — dedupe by pair_id to avoid double-counting m and negative
  // training_missing_pair_count.
  if (!seenPairIds) return outcomes;
  return outcomes.filter((outcome) => {
    if (!outcome.pair_id) return true;
    if (seenPairIds.has(outcome.pair_id)) return false;
    seenPairIds.add(outcome.pair_id);
    return true;
  });
}

export async function queryLevelOutcomes(input: {
  runner: QueryRunner;
  sql: string;
  comparisons: FellegiSunterScoring['comparisons'];
  labelsByPair?: Map<string, TruthsetLabel['label']>;
  requirePairId?: boolean;
}): Promise<LevelOutcome[]> {
  const rawRows = await input.runner.query(input.sql);
  return normalizeLevelOutcomeRows(
    rawRows,
    input.comparisons,
    input.labelsByPair,
    input.requirePairId ?? false
  );
}

export async function fetchLabeledOutcomes(input: {
  runner: QueryRunner;
  spec: ResolvedResolutionSpec;
  labels: TruthsetLabel[];
  schema: string;
  dialect: SupportedDialect;
}): Promise<LevelOutcome[]> {
  const scoring = assertFellegiSunterSpec(input.spec);
  const labelsByPair = new Map(input.labels.map((label) => [label.pair_id, label.label]));
  const outcomes: LevelOutcome[] = [];
  for (let index = 0; index < input.labels.length; index += 500) {
    const batch = input.labels.slice(index, index + 500);
    const sql = buildLabeledLevelOutcomeQuery(
      input.spec,
      batch.map((label) => label.pair_id),
      input.schema,
      input.dialect
    );
    outcomes.push(
      ...(await queryLevelOutcomes({
        runner: input.runner,
        sql,
        comparisons: scoring.comparisons,
        labelsByPair,
        requirePairId: true,
      }))
    );
  }
  return outcomes;
}

export async function fetchPriorAnchors(input: {
  runner: QueryRunner;
  spec: ResolvedResolutionSpec;
  schema: string;
  dialect: SupportedDialect;
}): Promise<{ deterministic_matches: number; total_pairs: number }> {
  const rawRows = await input.runner.query(
    buildDeterministicPriorAnchorQuery(input.spec, input.schema, input.dialect)
  );
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new CommandError('Runner prior-anchor query returned no rows.', 1);
  }
  const first = rawRows[0];
  if (!first || typeof first !== 'object') {
    throw new CommandError('Runner prior-anchor query returned an invalid row.', 1);
  }
  const record = first as Record<string, unknown>;
  const deterministicMatches = Number(record.deterministic_matches);
  const totalPairs = Number(record.total_pairs);
  if (!Number.isFinite(deterministicMatches) || !Number.isFinite(totalPairs)) {
    throw new CommandError('Runner prior-anchor query returned non-numeric counts.', 1);
  }
  return {
    deterministic_matches: deterministicMatches,
    total_pairs: totalPairs,
  };
}

/**
 * Collapse a truthset's labels to one per pair_id. A pair appearing twice would
 * otherwise land in both the train and holdout splits (leakage) and double-count
 * m; conflicting labels (merge + not_match for the same pair) are a data error,
 * not something to silently resolve to "last wins".
 */
export function dedupeTruthsetLabels(labels: TruthsetLabel[]): TruthsetLabel[] {
  const byPair = new Map<string, TruthsetLabel>();
  for (const label of labels) {
    const existing = byPair.get(label.pair_id);
    if (existing && existing.label !== label.label) {
      throw new CommandError(
        `Truthset label conflict for pair ${label.pair_id}: both "${existing.label}" and "${label.label}". Resolve the duplicate before training.`,
        2
      );
    }
    if (!existing) byPair.set(label.pair_id, label);
  }
  return [...byPair.values()];
}

export function labelsFromOutcomes(outcomes: LevelOutcome[]): TruthsetLabel[] {
  return outcomes
    .filter(
      (outcome): outcome is LevelOutcome & { pair_id: string; label: TruthsetLabel['label'] } =>
        Boolean(outcome.pair_id && outcome.label)
    )
    .map((outcome) => ({
      pair_id: outcome.pair_id,
      label: outcome.label,
    }));
}

export function findResolutionFile(
  entityGraphDir: string,
  resolutionName: string
): { filePath: string } | undefined {
  return discoverResolutionSpecs(entityGraphDir).find((spec) => spec.raw.name === resolutionName);
}
