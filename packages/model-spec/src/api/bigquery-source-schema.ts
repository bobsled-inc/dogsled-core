/**
 * BigQuery source-schema preflight: every column a model reads from a source
 * table must exist in that table's INFORMATION_SCHEMA.COLUMNS before any model
 * SQL runs.
 */

import { isCancellationError, throwIfCancelled } from '@bobsled-inc/connections';

import {
  extractColumnLineage,
  getSourceEntry,
  parseExprField,
  parseTransformSpecFromParsed,
  walkExpr,
  type ModelExecutionResult,
  type SqlRunnerModule,
} from '../compiler/index.js';
import { buildCanonicalBigQuerySetColumns } from '../compiler/set-operations.js';

import { fetchBigQueryColumns, parseBigQueryTableRef } from './bigquery-catalog.js';
import type { IntegrationCompileContext } from './integration-context.js';

interface SourceColumnUse {
  columns: Set<string>;
}

type SourceColumnUses = Map<string, Map<string, SourceColumnUse>>;

export async function preflightBigQuerySourceSchemas(
  ictx: IntegrationCompileContext,
  query: NonNullable<SqlRunnerModule['query']>,
  signal: AbortSignal | undefined,
  isBuiltSourceRead: (reader: string, sourceRef: string) => boolean
): Promise<ModelExecutionResult[]> {
  const uses = collectSourceColumnUses(ictx);
  const failures: ModelExecutionResult[] = [];

  for (const [sourceRef, allReaders] of uses) {
    throwIfCancelled(signal);
    // A source over a table that this run builds before the reader is checked
    // by the consuming model's dry run once that table exists.
    const byModel = new Map(
      [...allReaders].filter(([modelName]) => !isBuiltSourceRead(modelName, sourceRef))
    );
    if (byModel.size === 0) continue;
    const entry = getSourceEntry(ictx.entryRegistry, sourceRef);
    if (!entry || entry.kind !== 'warehouse_table') continue;

    const tableRef = parseBigQueryTableRef(entry.fqRef);
    if (!tableRef) {
      for (const modelName of byModel.keys()) {
        failures.push({
          modelName,
          status: 'failed',
          error: `BigQuery source-schema preflight could not parse source table "${entry.fqRef}" for ${sourceRef}. Expected dataset.table or project.dataset.table.`,
          exitCode: 2,
        });
      }
      continue;
    }

    let liveColumns: Set<string>;
    try {
      liveColumns = await fetchBigQueryColumns(query, tableRef, signal);
    } catch (err) {
      if (isCancellationError(err, signal)) throw err;
      for (const modelName of byModel.keys()) {
        failures.push({
          modelName,
          status: 'failed',
          error: `BigQuery source-schema preflight could not inspect ${entry.fqRef} via INFORMATION_SCHEMA.COLUMNS: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 2,
        });
      }
      continue;
    }

    if (liveColumns.size === 0) {
      for (const modelName of byModel.keys()) {
        failures.push({
          modelName,
          status: 'failed',
          error:
            `BigQuery source-schema preflight failed for ${modelName}: source table ${entry.fqRef} ` +
            `(${sourceRef}) was not found. Load or create the table before running models, ` +
            'or correct the source spec table.',
          exitCode: 2,
        });
      }
      continue;
    }

    for (const [modelName, use] of byModel) {
      const missing = [...use.columns]
        .filter((column) => !liveColumns.has(column.toLowerCase()))
        .sort((a, b) => a.localeCompare(b));
      if (missing.length === 0) continue;

      failures.push({
        modelName,
        status: 'failed',
        error:
          `BigQuery source-schema preflight failed for ${modelName}: source ${entry.fqRef} ` +
          `is missing referenced column(s): ${missing.join(', ')}. ` +
          'Update the source spec/model projection or evolve the raw table before running models.',
        exitCode: 2,
      });
    }
  }

  return failures;
}

function collectSourceColumnUses(ictx: IntegrationCompileContext): SourceColumnUses {
  const uses: SourceColumnUses = new Map();
  // Warehouse + api-resource sources have explicit YAML column schemas, so
  // `hasUnknownPassthrough` is always false here — matches `lineage-project.ts`.
  // Model-on-model passthrough isn't part of the preflight scope: we only check
  // columns referenced from registered source entries.
  const sourceColumns = new Map(
    [...ictx.entryRegistry.entries()].map(([ref, entry]) => [
      ref,
      {
        columns: entry.columns.map((column) => column.name),
        hasUnknownPassthrough: false,
      },
    ])
  );

  for (const node of ictx.orderedNodes) {
    const parsed = parseTransformSpecFromParsed(node.parsedSpec, ictx.registry, ictx.modelReg);
    if (!parsed.ok) {
      // Silent skip would let a bad plan proceed past preflight without
      // source-schema validation. `buildIntegrationPlan` re-parses the same
      // node afterwards and surfaces the same error via `CommandError`, so
      // this branch is normally unreachable — but treat it as a hard error
      // if it ever fires.
      throw new Error(`BigQuery preflight could not resolve model "${node.name}": ${parsed.error}`);
    }

    const { spec } = parsed;
    for (const lineage of extractColumnLineage(spec, { sourceColumns })) {
      for (const upstream of lineage.upstream) {
        if (!upstream.source || upstream.column === '*') continue;
        addSourceColumnUse(uses, upstream.source, node.name, upstream.column);
      }
    }

    for (const branch of spec.union ?? []) {
      const branchEntry = getSourceEntry(ictx.entryRegistry, branch.ref);
      if (!branchEntry) continue;
      const canonicalColumns = buildCanonicalBigQuerySetColumns(
        spec,
        ictx.dialect,
        ictx.entryRegistry
      );
      if (canonicalColumns) {
        const branchSourceColumns = new Set(
          branchEntry.columns.map((column) => column.name.toLowerCase())
        );
        const explicitColumns = new Map(
          (branch.columns ?? []).map((column) => [column.name.toLowerCase(), column.expr])
        );
        for (const column of canonicalColumns) {
          const explicitExpr = explicitColumns.get(column.name.toLowerCase());
          if (explicitExpr) {
            for (const sourceColumn of collectExpressionColumns(explicitExpr)) {
              addSourceColumnUse(uses, branch.ref, node.name, sourceColumn);
            }
          } else if (
            column.sourceColumnName &&
            branchSourceColumns.has(column.sourceColumnName.toLowerCase())
          ) {
            addSourceColumnUse(uses, branch.ref, node.name, column.sourceColumnName);
          } else if (!column.sourceColumnName && column.defaultExpr) {
            for (const sourceColumn of collectExpressionColumns(column.defaultExpr)) {
              addSourceColumnUse(uses, branch.ref, node.name, sourceColumn);
            }
          }
        }
      } else if (branch.includeAllColumns) {
        const excluded = new Set(
          (branch.excludeColumns ?? []).map((column) => column.toLowerCase())
        );
        for (const column of branchEntry.columns) {
          if (!excluded.has(column.name.toLowerCase())) {
            addSourceColumnUse(uses, branch.ref, node.name, column.name);
          }
        }
      } else if (!branch.columns) {
        for (const lineage of extractColumnLineage(spec, { sourceColumns })) {
          for (const upstream of lineage.upstream) {
            if (upstream.source !== spec.sourceRef || upstream.column === '*') continue;
            addSourceColumnUse(uses, branch.ref, node.name, upstream.column);
          }
        }
      }

      if (!canonicalColumns) {
        for (const column of branch.columns ?? []) {
          for (const sourceColumn of collectExpressionColumns(column.expr)) {
            addSourceColumnUse(uses, branch.ref, node.name, sourceColumn);
          }
        }
      }
      if (branch.filter) {
        for (const sourceColumn of collectExpressionColumns(branch.filter)) {
          addSourceColumnUse(uses, branch.ref, node.name, sourceColumn);
        }
      }
    }
  }

  return uses;
}

function addSourceColumnUse(
  uses: SourceColumnUses,
  sourceRef: string,
  modelName: string,
  column: string
): void {
  const byModel = uses.get(sourceRef) ?? new Map<string, SourceColumnUse>();
  const use = byModel.get(modelName) ?? { columns: new Set<string>() };
  use.columns.add(column);
  byModel.set(modelName, use);
  uses.set(sourceRef, byModel);
}

function collectExpressionColumns(expr: string): string[] {
  const ast = parseExprField(expr);
  const columns: string[] = [];
  walkExpr(ast, (node) => {
    if (node.kind === 'column_ref') columns.push(node.column);
  });
  return columns;
}
