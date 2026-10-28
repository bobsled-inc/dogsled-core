import { Option, type Command } from 'commander';
import { AUDIT_CATEGORIES, CommandError, type AuditCategory } from '@bobsled-inc/protocol';
import {
  createDialectOption,
  loadProjectConfig,
  loadRunnerModule,
  out,
  parsePositiveIntOption,
  resolveConfig,
} from '@bobsled-inc/model-spec/shared';

import {
  buildAuditListQuery,
  buildAuditVerifyQuery,
  ENTITY_GRAPH_SCHEMA,
} from '../compiler/audit/codegen.js';

import type { SupportedDialect } from '@bobsled-inc/model-spec';

interface AuditListOptions {
  clusterId?: string;
  subjectId?: string;
  category?: AuditCategory;
  subjectType?: string;
  payloadKind?: string;
  limit?: number;
  runner?: string;
  dialect?: SupportedDialect;
  contractSchema?: string;
  json?: boolean;
}

interface AuditVerifyOptions {
  runner?: string;
  dialect?: SupportedDialect;
  contractSchema?: string;
  json?: boolean;
}

function resolveAuditDialect(options: { dialect?: SupportedDialect }): SupportedDialect {
  const { config } = loadProjectConfig(process.cwd());
  return resolveConfig({ dialect: options.dialect }, config).dialect;
}

async function listHandler(options: AuditListOptions): Promise<void> {
  const dialect = resolveAuditDialect(options);
  const contractSchema = options.contractSchema ?? ENTITY_GRAPH_SCHEMA;
  const query = buildAuditListQuery(dialect, {
    contractSchema,
    clusterId: options.clusterId,
    subjectId: options.subjectId,
    category: options.category,
    subjectType: options.subjectType,
    payloadKind: options.payloadKind,
    limit: options.limit,
  });
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('runner must implement query(sql)', 2);
  }

  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'audit.list',
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
    command: 'audit.list',
    dialect,
    contract_schema: contractSchema,
    executed: true,
    rows,
  };
  if (options.json) {
    out.json(result);
  } else {
    out.yaml(result);
  }
}

async function verifyHandler(options: AuditVerifyOptions): Promise<void> {
  const dialect = resolveAuditDialect(options);
  const contractSchema = options.contractSchema ?? ENTITY_GRAPH_SCHEMA;
  const query = buildAuditVerifyQuery(dialect, contractSchema);
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('runner must implement query(sql)', 2);
  }

  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'audit.verify',
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
  const status = String(
    Object.entries(rows[0] ?? {}).find(([key]) => key.toLowerCase() === 'status')?.[1] ?? ''
  ).toLowerCase();
  const result = {
    command: 'audit.verify',
    dialect,
    contract_schema: contractSchema,
    executed: true,
    status,
    rows,
  };
  if (options.json) {
    out.json(result);
  } else {
    out.yaml(result);
  }
  if (status !== 'ok') {
    throw new CommandError('Audit verification failed.', 1);
  }
}

export function registerAuditCommand(program: Command): void {
  const audit = program.command('audit').description('Entity graph audit log commands');

  audit
    .command('list')
    .description('List audit events')
    .option('--cluster-id <value>', 'Filter by cluster ID')
    .option('--subject-id <value>', 'Filter by subject ID')
    .addOption(
      new Option('--category <value>', 'Filter by audit category').choices([...AUDIT_CATEGORIES])
    )
    .option('--subject-type <value>', 'Filter by subject type')
    .option('--payload-kind <value>', 'Filter by audit payload kind')
    .addOption(
      new Option('--limit <n>', 'Maximum number of events').argParser(parsePositiveIntOption)
    )
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--contract-schema <name>', 'Entity graph contract schema', ENTITY_GRAPH_SCHEMA)
    .option('--json', 'Output results as JSON')
    .addOption(createDialectOption())
    .action(async (opts: AuditListOptions) => {
      await listHandler(opts);
    });

  audit
    .command('verify')
    .description('Verify audit log continuity checks')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--contract-schema <name>', 'Entity graph contract schema', ENTITY_GRAPH_SCHEMA)
    .option('--json', 'Output results as JSON')
    .addOption(createDialectOption())
    .action(async (opts: AuditVerifyOptions) => {
      await verifyHandler(opts);
    });
}
