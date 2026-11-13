import * as fs from 'node:fs';
import * as path from 'node:path';

import { type Command, Option } from 'commander';
import YAML from 'yaml';
import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';
import { findAction, loadBuiltInActions } from '@bobsled-inc/integrations';
import { resolveProjectIndex } from '@bobsled-inc/project-index';
import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';
import {
  createDialectOption,
  loadProjectConfig,
  loadRunnerModule,
  out,
  parseGlobalFlags,
  parsePositiveIntOption,
  resolveConfig,
} from '@bobsled-inc/model-spec/shared';
import type { SupportedDialect } from '@bobsled-inc/model-spec';
import {
  runActivateDispatcher,
  emitActivationRecord,
  emitActivationMetric,
} from '@bobsled-inc/extractor';
import type { ActivationRecord, ActivationResult } from '@bobsled-inc/extractor';
import { ActionSpecSchema, IntegrationSpecSchema } from '@bobsled-inc/extractor/extractor';
import type { ApiIntegrationSpec } from '@bobsled-inc/extractor/extractor';

import {
  generateActivationDispatchAuditSql,
  generateActivationReceiptAuditSql,
  generatePolicyBlockAuditSql,
} from '../compiler/audit/subscribe-activation.js';
import { ENTITY_GRAPH_SCHEMA } from '../compiler/audit/codegen.js';
import { loadPolicySpec, loadPolicySpecFromFile } from '../compiler/policy/parser.js';
import { checkTrustGate } from '../compiler/policy/enforce.js';
import { jsonExtractString } from '../compiler/identity/sql.js';

const MAX_SPEC_SIZE = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadYamlSpec(filePath: string, label: string): unknown {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new CommandError(`${label} not found: ${resolved}`, 2);
  }
  const stats = fs.statSync(resolved);
  if (stats.size > MAX_SPEC_SIZE) {
    throw new CommandError(`${label} exceeds 1 MB limit: ${resolved}`, 2);
  }
  try {
    return YAML.parse(fs.readFileSync(resolved, 'utf-8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`${label} invalid YAML: ${resolved} - ${message}`, 2);
  }
}

function resolveActivateDialect(options: { dialect?: SupportedDialect }): SupportedDialect {
  const { config } = loadProjectConfig(process.cwd());
  return resolveConfig({ dialect: options.dialect }, config).dialect;
}

const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Validate and quote a user-supplied --projection value of the form <schema>.<table>.
 * Rejects anything that isn't a simple unquoted identifier pair to prevent SQL injection.
 */
function parseAndQuoteProjection(raw: string, dialect: SupportedDialect): string {
  const parts = raw.split('.');
  if (
    parts.length !== 2 ||
    !SAFE_IDENTIFIER_RE.test(parts[0] ?? '') ||
    !SAFE_IDENTIFIER_RE.test(parts[1] ?? '')
  ) {
    throw new CommandError(
      `--projection must be a simple <schema>.<table> identifier pair (got: ${raw})`,
      2
    );
  }
  return buildFqName(parts[0]!, parts[1]!, dialect);
}

/** SELECT * from a projection table, with optional LIMIT. */
function buildProjectionQuery(
  projectionTable: string,
  dialect: SupportedDialect,
  limit?: number
): string {
  return [
    `SELECT *`,
    `FROM ${projectionTable}`,
    limit != null ? `LIMIT ${quoteLiteral(limit, dialect)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Query audit_log for activation dispatch/receipt rows. */
function buildReceiptsQuery(
  dialect: SupportedDialect,
  options: {
    contractSchema: string;
    syncName?: string;
    since?: string;
    status?: string;
    limit?: number;
  }
): string {
  const tableName = buildFqName(options.contractSchema, 'audit_log', dialect);
  const payload = quoteIdentifier('payload', dialect);
  const occurredAt = quoteIdentifier('occurred_at', dialect);

  const predicates: string[] = [
    `${quoteIdentifier('category', dialect)} = ${quoteLiteral('dispatch', dialect)}`,
    `${jsonExtractString(payload, 'kind', dialect)} IN (${quoteLiteral('activation_dispatch', dialect)}, ${quoteLiteral('activation_receipt', dialect)})`,
  ];

  if (options.syncName) {
    predicates.push(
      `${jsonExtractString(payload, 'sync_name', dialect)} = ${quoteLiteral(options.syncName, dialect)}`
    );
  }
  if (options.since) {
    predicates.push(`${occurredAt} >= ${quoteLiteral(options.since, dialect)}`);
  }
  if (options.status) {
    predicates.push(
      `${jsonExtractString(payload, 'status', dialect)} = ${quoteLiteral(options.status, dialect)}`
    );
  }

  return [
    `SELECT *`,
    `FROM ${tableName}`,
    `WHERE ${predicates.join('\n  AND ')}`,
    `ORDER BY ${occurredAt}, ${quoteIdentifier('event_id', dialect)}`,
    options.limit != null ? `LIMIT ${quoteLiteral(options.limit, dialect)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Main activate handler
// ---------------------------------------------------------------------------

interface ActivateOptions {
  action?: string;
  actionName?: string;
  integration?: string;
  projection?: string;
  entity?: string;
  schema?: string;
  runner?: string;
  dryRun?: boolean;
  limit?: number;
  consecutiveFailureThreshold?: number;
  policyFile?: string;
  verbose?: boolean;
  quiet?: boolean;
  specDir?: string;
  contractSchema?: string;
  dialect?: SupportedDialect;
  json?: boolean;
}

async function activateHandler(syncName: string, options: ActivateOptions): Promise<void> {
  const dialect = resolveActivateDialect(options);
  const contractSchema = options.contractSchema ?? ENTITY_GRAPH_SCHEMA;
  const dryRun = options.dryRun ?? false;

  // Validate user-supplied SQL identifiers before any SQL generation
  if (!SAFE_IDENTIFIER_RE.test(syncName)) {
    throw new CommandError(
      `<sync_name> must be a simple identifier [A-Za-z_][A-Za-z0-9_$]* (got: ${syncName})`,
      2
    );
  }
  if (options.entity && !SAFE_IDENTIFIER_RE.test(options.entity)) {
    throw new CommandError(
      `--entity must be a simple identifier [A-Za-z_][A-Za-z0-9_$]* (got: ${options.entity})`,
      2
    );
  }
  if (options.schema && !SAFE_IDENTIFIER_RE.test(options.schema)) {
    throw new CommandError(
      `--schema must be a simple identifier [A-Za-z_][A-Za-z0-9_$]* (got: ${options.schema})`,
      2
    );
  }
  if (options.contractSchema && !SAFE_IDENTIFIER_RE.test(options.contractSchema)) {
    throw new CommandError(
      `--contract-schema must be a simple identifier [A-Za-z_][A-Za-z0-9_$]* (got: ${options.contractSchema})`,
      2
    );
  }

  // --- Load and validate action spec ---
  if (!options.action && !options.actionName) {
    throw new CommandError('Provide --action <path> or --action-name <qualified>', 2);
  }
  if (options.action && options.actionName) {
    throw new CommandError('Use either --action <path> or --action-name <qualified>, not both.', 2);
  }
  const rawAction = options.actionName
    ? (() => {
        const result = findAction(
          loadBuiltInActions(resolveProjectIndex(process.cwd())),
          options.actionName
        );
        if (result.kind === 'found') return result.action.spec;
        if (result.kind === 'ambiguous') {
          throw new CommandError(
            `Action name "${options.actionName}" is ambiguous. Use one of: ${result.actions
              .map((action) => action.qualifiedName)
              .join(', ')}`,
            2
          );
        }
        throw new CommandError(`Action not found: ${options.actionName}`, 2);
      })()
    : loadYamlSpec(options.action!, 'Action spec');
  const actionParsed = ActionSpecSchema.safeParse(rawAction);
  if (!actionParsed.success) {
    throw new CommandError(
      formatSpecValidationMessage(
        'action',
        options.action ?? options.actionName ?? '<unknown>',
        actionParsed.error,
        { schema: ActionSpecSchema }
      ),
      2
    );
  }
  const actionSpec = actionParsed.data;

  if (actionSpec.transport !== 'api') {
    throw new CommandError(`Only transport: api is supported (got: ${actionSpec.transport})`, 2);
  }

  // --- Load and validate integration spec ---
  if (!options.integration) {
    throw new CommandError('--integration <path> is required for api transport actions', 2);
  }
  const rawIntegration = loadYamlSpec(options.integration, 'Integration spec');
  const integrationParsed = IntegrationSpecSchema.safeParse(rawIntegration);
  if (!integrationParsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('integration', options.integration, integrationParsed.error, {
        schema: IntegrationSpecSchema,
      }),
      2
    );
  }
  const parsedIntegration = integrationParsed.data;

  // Guard: only api integration specs are supported (not warehouse variants)
  if (
    'source_type' in parsedIntegration &&
    parsedIntegration.source_type !== undefined &&
    parsedIntegration.source_type !== 'api'
  ) {
    throw new CommandError(
      `Only api integration specs are supported for activation (got source_type: ${String(parsedIntegration.source_type)})`,
      2
    );
  }
  const integrationSpec = parsedIntegration as ApiIntegrationSpec;

  // --- Load policy spec ---
  const policySpecDir = options.specDir ?? process.cwd();
  const policyResult = options.policyFile
    ? { spec: loadPolicySpecFromFile(options.policyFile), filePath: options.policyFile }
    : loadPolicySpec(policySpecDir);

  // --- Resolve projection table reference ---
  let projectionRef: string;
  if (options.projection) {
    projectionRef = parseAndQuoteProjection(options.projection, dialect);
  } else if (options.entity && options.schema) {
    projectionRef = buildFqName(
      options.schema,
      `${options.entity}__${syncName}__projection`,
      dialect
    );
  } else {
    throw new CommandError(
      'Provide --projection <fq_table> OR both --entity <name> and --schema <schema>',
      2
    );
  }

  // --- Load runner ---
  if (!options.runner) {
    throw new CommandError('--runner <path> is required', 2);
  }
  const runnerModule = await loadRunnerModule(options.runner);
  if (runnerModule.query == null) {
    throw new CommandError('runner must implement query(sql)', 2);
  }
  if (runnerModule.run == null) {
    throw new CommandError('runner must implement run(sql)', 2);
  }
  const runFn = runnerModule.run;

  // --- Query projection table ---
  const projectionQuery = buildProjectionQuery(projectionRef, dialect, options.limit);
  const rawRows = (await runnerModule.query(projectionQuery)) as unknown[];
  if (!Array.isArray(rawRows)) {
    throw new CommandError('Runner returned non-array for projection query', 1);
  }
  const records = rawRows.map((row, idx) => {
    if (typeof row !== 'object' || row === null || !('entity_id' in row)) {
      throw new CommandError(`Projection row ${idx} is missing required field 'entity_id'`, 1);
    }
    return row as ActivationRecord;
  });

  // --- Trust gate ---
  const policyName = policyResult?.spec.name ?? '(none)';
  const trustBlocked: string[] = [];
  const dispatchRecords: ActivationRecord[] = [];

  if (policyResult) {
    for (const record of records) {
      const entityId = String(record.entity_id);
      const trustScore = Number(record.entity_trust_score);
      if (!Number.isFinite(trustScore)) {
        trustBlocked.push(entityId);
        const auditStmt = generatePolicyBlockAuditSql({
          entityId,
          clusterId: record.cluster_id as string | number | undefined,
          policyName,
          reason: `entity_trust_score is not a finite number (got: ${String(record.entity_trust_score)})`,
          dialect,
          contractSchema,
        });
        await runFn(auditStmt.sql);
        continue;
      }
      const gate = checkTrustGate(policyResult.spec, entityId, trustScore);
      if (!gate.passed) {
        trustBlocked.push(entityId);
        const auditStmt = generatePolicyBlockAuditSql({
          entityId,
          clusterId: record.cluster_id as string | number | undefined,
          policyName,
          reason: `entity_trust_score ${trustScore} < threshold ${gate.threshold}`,
          dialect,
          contractSchema,
        });
        await runFn(auditStmt.sql);
      } else {
        dispatchRecords.push(record);
      }
    }
  } else {
    dispatchRecords.push(...records);
  }

  // --- Dispatch ---
  const summary = await runActivateDispatcher({
    actionSpec,
    integrationSpec,
    records: dispatchRecords,
    projectionRef,
    syncName,
    dryRun,
    consecutiveFailureThreshold: options.consecutiveFailureThreshold,
    onResult: async (result: ActivationResult) => {
      emitActivationRecord(result);

      const auditInput = {
        entityId: result.entity_id,
        clusterId: result.cluster_id as string | number | undefined,
        syncName,
        projectionRef,
        status: result.status,
        idempotencyKey: result.idempotency_key,
        action: result.action,
        durationMs: result.duration_ms,
        errorCode: result.error?.code,
        errorMessage: result.error?.message,
        dialect,
        contractSchema,
      };
      await runFn(generateActivationDispatchAuditSql(auditInput).sql);
      await runFn(generateActivationReceiptAuditSql(auditInput).sql);
    },
  });

  // --- Emit metric summary to stderr ---
  emitActivationMetric({
    sync_name: syncName,
    succeeded: summary.succeeded,
    failed: summary.failed,
    skipped: summary.skipped,
    total: records.length,
  });

  if (options.json) {
    out.json({
      command: 'activate',
      sync_name: syncName,
      action: actionSpec.name,
      projection_ref: projectionRef,
      dialect,
      dry_run: dryRun,
      total_records: records.length,
      trust_blocked: trustBlocked.length,
      dispatched: dispatchRecords.length,
      ...summary,
    });
  } else {
    out.success(
      `Activation complete — sync: ${syncName}, ` +
        `dispatched: ${dispatchRecords.length}, succeeded: ${summary.succeeded}, ` +
        `failed: ${summary.failed}, skipped: ${summary.skipped}, trust_blocked: ${trustBlocked.length}`
    );
  }
}

// ---------------------------------------------------------------------------
// Receipts handler
// ---------------------------------------------------------------------------

interface ReceiptsOptions {
  sync?: string;
  since?: string;
  status?: string;
  limit?: number;
  runner?: string;
  contractSchema?: string;
  dialect?: SupportedDialect;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

async function receiptsHandler(options: ReceiptsOptions): Promise<void> {
  const dialect = resolveActivateDialect(options);
  const contractSchema = options.contractSchema ?? ENTITY_GRAPH_SCHEMA;

  if (options.contractSchema && !SAFE_IDENTIFIER_RE.test(options.contractSchema)) {
    throw new CommandError(
      `--contract-schema must be a simple identifier [A-Za-z_][A-Za-z0-9_$]* (got: ${options.contractSchema})`,
      2
    );
  }

  const query = buildReceiptsQuery(dialect, {
    contractSchema,
    syncName: options.sync,
    since: options.since,
    status: options.status,
    limit: options.limit,
  });

  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (runner != null && runner.query == null) {
    throw new CommandError('runner must implement query(sql)', 2);
  }

  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'activate.receipts',
        dialect,
        contract_schema: contractSchema,
        executed: false,
        query,
      });
      return;
    }
    out.text(`${query}\n`);
    return;
  }

  const rows = await runner.query(query);
  const result = {
    command: 'activate.receipts',
    dialect,
    contract_schema: contractSchema,
    executed: true,
    sync_name: options.sync,
    row_count: Array.isArray(rows) ? rows.length : 0,
    rows,
  };
  if (options.json) {
    out.json(result);
  } else {
    out.yaml(result);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerActivateCommand(program: Command): void {
  const activate = program
    .command('activate <sync_name>')
    .description('Dispatch projection records to an external API via an action spec')
    .option('--action <path>', 'Path to action YAML spec')
    .option('--action-name <qualified>', 'Registry action name such as salesforce/upsert_contact')
    .option('--integration <path>', 'Path to integration YAML spec (required for api transport)')
    .option(
      '--projection <fq_table>',
      'Fully-qualified projection table (overrides --entity/--schema)'
    )
    .option('--entity <name>', 'Entity name (used to compute projection table name)')
    .option('--schema <schema>', 'Schema where the projection table lives')
    .option('--runner <path>', 'Path to SQL runner module (must implement query and run)')
    .option('--dry-run', 'Validate without making HTTP calls')
    .addOption(
      new Option('--limit <n>', 'Max records to read from projection').argParser(
        parsePositiveIntOption
      )
    )
    .addOption(
      new Option(
        '--consecutive-failure-threshold <n>',
        'Abort after N consecutive dispatch failures'
      ).argParser(parsePositiveIntOption)
    )
    .option(
      '--policy-file <path>',
      'Path to policy YAML spec (overrides --spec-dir auto-discovery)'
    )
    .option('--spec-dir <dir>', 'Directory to discover *.policy.yml files')
    .option('--contract-schema <name>', 'Entity graph audit schema', ENTITY_GRAPH_SCHEMA)
    .addOption(createDialectOption())
    .option('--json', 'Emit JSON summary (protocol RECORDs always go to stdout)')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(async (syncName: string, opts: ActivateOptions) => {
      const { json } = parseGlobalFlags(opts);
      await activateHandler(syncName, { ...opts, json });
    });

  activate
    .command('receipts')
    .description('Query activation dispatch/receipt events from the audit log')
    .option('--sync <name>', 'Filter by sync name')
    .option('--since <iso_timestamp>', 'Filter events on or after this timestamp')
    .addOption(
      new Option('--status <value>', 'Filter by activation status').choices([
        'succeeded',
        'failed',
        'skipped',
      ])
    )
    .addOption(new Option('--limit <n>', 'Max rows to return').argParser(parsePositiveIntOption))
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--contract-schema <name>', 'Entity graph audit schema', ENTITY_GRAPH_SCHEMA)
    .addOption(createDialectOption())
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(async (opts: ReceiptsOptions) => {
      const { json } = parseGlobalFlags(opts);
      await receiptsHandler({ ...opts, json });
    });
}
