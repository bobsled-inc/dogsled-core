import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import { out } from '@bobsled-inc/model-spec/shared';

import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';
import {
  isLoopbackHost,
  isWildcardHost,
  startEntityGraphHttpServer,
} from '../runtime/services/index.js';

interface ServeOptions {
  port: string;
  host?: string;
  runner?: string;
  integration?: string;
  dialect?: string;
  schema?: string;
  secrets?: string;
  allowRemote?: boolean;
  allowWrites?: boolean;
  json?: boolean;
  yaml?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CommandError('--port must be an integer between 1 and 65535.', 2);
  }
  return port;
}

function requiresRemoteAcknowledgement(host: string | undefined): boolean {
  const boundHost = host ?? '127.0.0.1';
  return isWildcardHost(boundHost) || !isLoopbackHost(boundHost);
}

function assertRemoteAcknowledgement(options: ServeOptions): boolean {
  const envSet = process.env['DOGSLED_ENTITY_GRAPH_ALLOW_REMOTE'] === '1';
  const flagSet = options.allowRemote === true;
  if (flagSet && !envSet) {
    throw new CommandError(
      '--allow-remote passed but DOGSLED_ENTITY_GRAPH_ALLOW_REMOTE=1 is not set. Both are required to expose the unauthenticated entity graph API off loopback.',
      2
    );
  }
  if (requiresRemoteAcknowledgement(options.host) && !(flagSet && envSet)) {
    throw new CommandError(
      'entity-graph serve only binds to loopback by default. To bind a non-loopback host, pass --allow-remote and set DOGSLED_ENTITY_GRAPH_ALLOW_REMOTE=1.',
      2
    );
  }
  return flagSet && envSet;
}

async function serveHandler(options: ServeOptions): Promise<void> {
  const allowRemote = assertRemoteAcknowledgement(options);
  const context = await loadEntityGraphProjectContext({
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
  });
  const runnerHandle = await resolveEntityGraphRunner({
    cwd: context.cwd,
    runnerPath: options.runner,
    integration: context.integration,
    secrets: options.secrets,
    allowLocalRunnerFallback: false,
  });
  if (!runnerHandle?.runner.query) {
    await runnerHandle?.close();
    throw new CommandError(
      'entity-graph serve requires --runner <path> or an integration-backed query runner.',
      2
    );
  }

  let started: ReturnType<typeof startEntityGraphHttpServer> | undefined;
  try {
    started = startEntityGraphHttpServer({
      runner: runnerHandle.runner,
      schema: context.targetSchema,
      dialect: context.dialect,
      specs: context.specs,
      host: options.host,
      port: parsePort(options.port),
      allowRemote,
      allowWrites: options.allowWrites,
    });
    await started.ready;
    const payload = {
      command: 'entity_graph.serve',
      url: started.url,
      schema: context.targetSchema,
      dialect: context.dialect,
      allow_writes: Boolean(options.allowWrites),
      allow_remote: allowRemote,
      warnings: [
        'entity-graph serve does not enforce request principals; bind to loopback unless the API is isolated behind trusted access controls.',
      ],
    };
    if (!options.quiet) {
      out.warn(
        'Entity graph API does not enforce request principals; bind to loopback unless access is isolated.'
      );
    }
    if (options.verbose && !options.quiet) {
      out.info(
        `Serving ${context.specs.length} entity spec(s) from schema ${context.targetSchema} using ${context.dialect}.`
      );
    }
    if (options.json) {
      out.json(payload);
    } else if (options.yaml) {
      out.yaml(payload);
    } else if (!options.quiet) {
      out.success(`Entity graph API listening on ${started.url}`);
    }
    await new Promise<void>((resolve, reject) => {
      started?.server.once('close', resolve);
      started?.server.once('error', reject);
      process.once('SIGINT', () => started?.server.close());
      process.once('SIGTERM', () => started?.server.close());
    });
  } finally {
    if (started?.server.listening) {
      await new Promise<void>((resolve) => started?.server.close(() => resolve()));
    }
    await runnerHandle.close();
  }
}

export function registerServeCommand(parent: Command): void {
  parent
    .command('serve')
    .description('Serve the entity graph HTTP data access API')
    .requiredOption('--port <port>', 'Port to listen on')
    .option('--host <host>', 'Host to bind (defaults to 127.0.0.1)')
    .option('--runner <path>', 'SQL runner module with run/query')
    .option('--integration <name>', 'Integration handle to use')
    .option('--dialect <dialect>', 'SQL dialect when no integration is configured')
    .option('--schema <schema>', 'Target schema override')
    .option('--secrets <path>', 'Secrets file for integration-backed runners')
    .option('--allow-remote', 'Allow non-loopback binds with env double-gate', false)
    .option('--allow-writes', 'Allow POST /match modes assign and stage', false)
    .option('--json', 'Emit startup metadata as JSON')
    .option('--yaml', 'Emit startup metadata as YAML')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-essential output')
    .action(async (options: ServeOptions) => {
      await serveHandler(options);
    });
}
