import { Command } from 'commander';
import {
  CommandError,
  emitError,
  emitPayload,
  resolveOutputFormat,
  type Writer,
} from '@bobsled-inc/protocol';
import {
  createOrReplaceTableAs,
  getCanonicalDialect,
  isSupportedDialect,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import {
  buildCompactionSelect,
  relationshipExclusivityPairs,
  type RelationshipExclusivityPair,
} from '../compiler/relationship/compaction.js';
import {
  discoverRelationshipOntologySpecs,
  resolveRelationshipOntologySpec,
} from '../compiler/ontology/parser.js';
import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';
import { assertSafeIdentifier } from '../runtime/candidate-retrieval/sql-utils.js';
import { resolveCommandWriter } from './utils.js';

export interface RelationshipsCompactOptions {
  writer?: Writer;
  runner?: string;
  schema?: string;
  evidenceTable?: string;
  decisionsTable?: string;
  targetTable?: string;
  dialect?: SupportedDialect;
  dryRun?: boolean;
  /**
   * Project root from which to load `relationship_ontology` specs for
   * exclusive_with conflict detection. Defaults to `process.cwd()` when
   * omitted. Callers supplying `exclusivityPairs` directly bypass project
   * discovery.
   */
  cwd?: string;
  /**
   * Pre-computed exclusivity pairs (advanced / test seam). When provided,
   * project ontology discovery is skipped.
   */
  exclusivityPairs?: readonly RelationshipExclusivityPair[];
  integration?: string;
  verbose?: boolean;
  quiet?: boolean;
}

function lineageRunIdExpressionForDialect(dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'bigquery':
      return 'CAST(CURRENT_TIMESTAMP() AS STRING)';
    case 'postgres':
      return 'CAST(CURRENT_TIMESTAMP AS TEXT)';
    case 'mysql':
      return 'CAST(CURRENT_TIMESTAMP AS CHAR)';
    case 'snowflake':
    case 'databricks':
    case 'duckdb':
      return 'CAST(CURRENT_TIMESTAMP AS VARCHAR)';
    case 'clickhouse':
      return 'CAST(CURRENT_TIMESTAMP AS String)';
  }
}

export function buildRelationshipsCompactSql(options: RelationshipsCompactOptions = {}): string {
  const schema = options.schema ?? 'entity_graph';
  const targetTable = assertSafeIdentifier(
    options.targetTable ?? `${schema}.__entity_relationship`,
    'relationship target table'
  );
  const dialect = options.dialect ?? 'duckdb';
  const evidenceTable = assertSafeIdentifier(
    options.evidenceTable ?? `${schema}.__entity_relationship_evidence`,
    'relationship evidence table'
  );
  const decisionsTable = assertSafeIdentifier(
    options.decisionsTable ?? `${schema}.__entity_relationship_decisions`,
    'relationship decisions table'
  );
  return [
    createOrReplaceTableAs(targetTable, dialect),
    buildCompactionSelect({
      evidenceTable,
      decisionsTable,
      lineageRunIdExpression: lineageRunIdExpressionForDialect(dialect),
      dialect,
      ...(options.exclusivityPairs ? { exclusivityPairs: options.exclusivityPairs } : {}),
    }),
  ].join('\n');
}

/**
 * Discover relationship ontology specs in the project's `mdmDir` and
 * return the directed exclusivity pairs they declare. Returns an empty
 * array when the directory is not a Dogsled project, no ontology spec
 * exists, or the project loader fails — the compaction command treats
 * absence of an ontology as "skip ontology-driven conflict marking" and
 * preserves the legacy decision-only ranking.
 */
async function discoverProjectExclusivityPairs(
  cwd: string,
  integration?: string
): Promise<RelationshipExclusivityPair[]> {
  let mdmDir: string;
  try {
    const context = await loadEntityGraphProjectContext({
      cwd,
      ...(integration ? { integration } : {}),
    });
    mdmDir = context.mdmDir;
  } catch {
    return [];
  }
  const specs = discoverRelationshipOntologySpecs(mdmDir, cwd);
  if (specs.length === 0) return [];
  const pairs: RelationshipExclusivityPair[] = [];
  for (const spec of specs) {
    const resolved = resolveRelationshipOntologySpec(spec);
    pairs.push(...relationshipExclusivityPairs(resolved));
  }
  return pairs;
}

async function resolveCompactRunner(options: RelationshipsCompactOptions) {
  const cwd = options.cwd ?? process.cwd();
  if (options.runner) {
    return resolveEntityGraphRunner({
      cwd,
      runnerPath: options.runner,
      allowLocalRunnerFallback: false,
    });
  }
  if (!options.integration) return undefined;
  const context = await loadEntityGraphProjectContext({
    cwd,
    integration: options.integration,
    schema: options.schema,
  });
  return resolveEntityGraphRunner({
    cwd: context.cwd,
    integration: context.integration,
    allowLocalRunnerFallback: false,
  });
}

export async function runRelationshipsCompact(options: RelationshipsCompactOptions = {}): Promise<{
  ok: true;
  executed: boolean;
  sql: string;
  exclusivity_pairs: number;
}> {
  const exclusivityPairs =
    options.exclusivityPairs ??
    (await discoverProjectExclusivityPairs(options.cwd ?? process.cwd(), options.integration));
  const sql = buildRelationshipsCompactSql({ ...options, exclusivityPairs });
  if (options.dryRun) {
    return { ok: true, executed: false, sql, exclusivity_pairs: exclusivityPairs.length };
  }
  const runnerHandle = await resolveCompactRunner(options);
  if (!runnerHandle) {
    throw new CommandError(
      'relationships compact requires --runner <path> or --integration <handle> unless --dry-run is set.',
      2
    );
  }
  try {
    if (!runnerHandle.runner.run) {
      throw new CommandError(
        'relationships compact requires a runner module that exports run(sql).',
        2
      );
    }
    await runnerHandle.runner.run(sql);
  } finally {
    await runnerHandle.close();
  }
  return { ok: true, executed: true, sql, exclusivity_pairs: exclusivityPairs.length };
}

export function registerRelationshipsCompactCommand(
  parent: Command,
  options: RelationshipsCompactOptions = {}
): void {
  parent
    .command('compact')
    .description('Compact __entity_relationship_evidence into __entity_relationship')
    .option('--runner <path>', 'Path to SQL runner module with run(sql)')
    .option('--schema <name>', 'Schema containing relationship tables', options.schema)
    .option('--evidence-table <name>', 'Fully qualified evidence table', options.evidenceTable)
    .option('--decisions-table <name>', 'Fully qualified decisions table', options.decisionsTable)
    .option('--target-table <name>', 'Fully qualified compacted target table', options.targetTable)
    .option('--dialect <dialect>', 'SQL dialect for replacement DDL', options.dialect ?? 'duckdb')
    .option('--cwd <path>', 'Project root for ontology discovery', options.cwd)
    .option(
      '--integration <handle>',
      'Integration handle for project resolution',
      options.integration
    )
    .option('--dry-run', 'Emit SQL without executing it', false)
    .option('--json', 'Machine-readable JSON output', false)
    .option('--yaml', 'Machine-readable YAML output', false)
    .option('--verbose', 'Verbose logging', false)
    .option('--quiet', 'Suppress non-error output', false)
    .action(
      async (opts: {
        runner?: string;
        schema?: string;
        evidenceTable?: string;
        decisionsTable?: string;
        targetTable?: string;
        dialect: string;
        cwd?: string;
        integration?: string;
        dryRun: boolean;
        json: boolean;
        yaml: boolean;
        verbose: boolean;
        quiet: boolean;
      }) => {
        const format = resolveOutputFormat({ json: opts.json, yaml: opts.yaml });
        const quiet = opts.quiet || options.quiet === true;
        const commandOptions = {
          ...options,
          verbose: opts.verbose || options.verbose === true,
          quiet,
        };
        const writer = resolveCommandWriter(commandOptions);
        try {
          if (!isSupportedDialect(opts.dialect)) {
            throw new CommandError(`Unsupported dialect '${opts.dialect}'.`, 2);
          }
          const result = await runRelationshipsCompact({
            ...commandOptions,
            runner: opts.runner ?? options.runner,
            schema: opts.schema ?? options.schema,
            evidenceTable: opts.evidenceTable ?? options.evidenceTable,
            decisionsTable: opts.decisionsTable ?? options.decisionsTable,
            targetTable: opts.targetTable ?? options.targetTable,
            dialect: opts.dialect,
            cwd: opts.cwd ?? options.cwd,
            ...((opts.integration ?? options.integration)
              ? { integration: opts.integration ?? options.integration }
              : {}),
            dryRun: opts.dryRun ?? options.dryRun,
          });
          if (!quiet) {
            emitPayload(result, format, writer, () =>
              result.executed
                ? 'Compacted relationship evidence into __entity_relationship.'
                : result.sql
            );
          }
        } catch (err) {
          if (err instanceof CommandError) {
            process.exitCode = err.exitCode;
            emitError(err.message, format, writer);
            return;
          }
          throw err;
        }
      }
    );
}
