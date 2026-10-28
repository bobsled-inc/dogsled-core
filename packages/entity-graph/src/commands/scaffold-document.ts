import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import { resolvePathWithinDir, validateScaffoldName } from '@bobsled-inc/model-spec/shared';

import { renderDocumentResolutionSpec } from '../templates/document.js';
import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';
import { resolveEntityGraphScaffoldPaths } from './scaffold-utils.js';

export interface ScaffoldDocumentOptions {
  cwd?: string;
  integration?: string;
  resource?: string;
  dryRun?: boolean;
}

export interface ScaffoldDocumentPayload {
  command: 'entity-graph.scaffold.document';
  entity: string;
  integration: string;
  resource: string;
  spec_path: string;
  dry_run: boolean;
  created: boolean;
  spec: string;
}

function atomicWriteTextFile(target: string, content: string): boolean {
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf-8');
    if (existing === content || existing === `${content}\n`) return false;
    throw new CommandError(`Refusing to overwrite existing document scaffold: ${target}`, 2);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
    });
    fs.renameSync(tmp, target);
    return true;
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup of an implementation-private temp file.
    }
    throw error;
  }
}

export function runScaffoldDocument(
  entity: string,
  options: ScaffoldDocumentOptions = {}
): ScaffoldDocumentPayload {
  if (!options.integration) {
    throw new CommandError('scaffold document requires --integration <handle>.', 2);
  }
  if (!options.resource) {
    throw new CommandError('scaffold document requires --resource <name>.', 2);
  }

  const paths = resolveEntityGraphScaffoldPaths(options.cwd);
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  const safeIntegration = validateScaffoldName(options.integration, 'Integration handle');
  const safeResource = validateScaffoldName(options.resource, 'Resource name');
  const spec = renderDocumentResolutionSpec({ resourceName: safeResource });
  const specPath = resolvePathWithinDir(
    paths.entityGraphDir,
    path.join('document', safeIntegration, safeResource, `${safeEntity}_resolution.yml`),
    'Document scaffold path'
  );

  const dryRun = options.dryRun === true;
  const created = dryRun ? false : atomicWriteTextFile(specPath, spec);
  return {
    command: 'entity-graph.scaffold.document',
    entity: safeEntity,
    integration: safeIntegration,
    resource: safeResource,
    spec_path: specPath,
    dry_run: dryRun,
    created,
    spec,
  };
}

function renderScaffoldDocumentText(payload: ScaffoldDocumentPayload): string {
  if (payload.dry_run) {
    return payload.spec;
  }
  return `${payload.created ? 'Created' : 'Exists'} document scaffold: ${payload.spec_path}`;
}

function resolveFormat(options: {
  format?: string;
  json?: boolean;
  yaml?: boolean;
}): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'yaml',
  });
}

export function registerScaffoldDocumentCommand(parent: Command): void {
  parent
    .command('document')
    .description('Create an explicit document-resolution scaffold for a document resource')
    .argument('<entity>', 'Document entity name')
    .requiredOption('--integration <handle>', 'Integration handle that owns the resource')
    .requiredOption('--resource <name>', 'Document resource name')
    .option('--dry-run', 'Print proposed spec without writing it', false)
    .option('--format <format>', 'Output format: text | json | yaml')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .action(
      (
        entity: string,
        opts: {
          integration: string;
          resource: string;
          dryRun: boolean;
          format?: string;
          json?: boolean;
          yaml?: boolean;
        }
      ) => {
        const payload = runScaffoldDocument(entity, opts);
        emitEntityGraphPayload(payload, resolveFormat(opts), () =>
          renderScaffoldDocumentText(payload)
        );
      }
    );
}
