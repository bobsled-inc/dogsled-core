import { Command } from 'commander';
import { boundedLines } from '../lib/bounded-lines.js';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  createOntologyTools,
  readConversionInput,
  writeConversionFiles,
} from '@bobsled-inc/model-spec/ontology';
import type { ConversionResult } from '@bobsled-inc/model-spec/interchange';
import * as fmt from '../lib/output/formatter.js';

interface Options {
  projectRoot?: string;
  json?: boolean;
  yaml?: boolean;
  strict?: boolean;
  apply?: boolean;
  delete?: boolean;
  concept?: string;
  limit?: string;
  ossieVersion?: string;
  out?: string;
  connection?: string;
  allowWrite?: boolean;
}
function tools(options: Options) {
  return createOntologyTools({
    projectRoot: resolve(options.projectRoot ?? '.'),
    authorize: () => true,
  });
}
function print(value: unknown, options: Options) {
  if (options.yaml) {
    fmt.output(stringify(value).trimEnd(), {
      ...fmt.toOutputOptions({ json: false, quiet: false, verbose: false, noColor: true }),
      json: false,
    });
  } else {
    fmt.output(value, {
      ...fmt.toOutputOptions({ json: false, quiet: false, verbose: false, noColor: true }),
      json: true,
    });
  }
}
async function run(name: string, input: unknown, options: Options) {
  const result = await tools(options).call(name, input);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    process.exitCode = 2;
  }
  if (options.out && name === 'ontology_export') {
    writeConversionFiles(result as ConversionResult, options.out);
  }
  print(result, options);
}
export async function serveOntologyMcp(options: Options): Promise<void> {
  const server = createOntologyTools({
    projectRoot: resolve(options.projectRoot ?? '.'),
    authorize: (mode) => mode === 'read' || options.allowWrite === true,
  });
  const lines = boundedLines(process.stdin, 1_000_000);
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    for await (const line of lines) {
      let id: unknown = null;
      try {
        const request = JSON.parse(line) as {
          id?: string | number;
          method?: string;
          params?: { name?: string; arguments?: unknown };
        };
        id = request.id ?? null;
        if (request.method?.startsWith('notifications/')) continue;
        let result: unknown;
        if (request.method === 'initialize') {
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'bobsled-ontology', version: '1' },
          };
        } else if (request.method === 'ping') result = {};
        else if (request.method === 'tools/list') result = { tools: server.tools };
        else if (request.method === 'tools/call') {
          const data = await server.call(
            request.params?.name ?? '',
            request.params?.arguments ?? {}
          );
          result = {
            content: [{ type: 'text', text: JSON.stringify(data) }],
            isError: !!(data && typeof data === 'object' && 'ok' in data && data.ok === false),
          };
        } else throw new Error('Unknown MCP method.');
        send({ jsonrpc: '2.0', id, result });
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: error instanceof Error ? error.message : 'Ontology request failed.',
          },
        });
      }
    }
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: error instanceof Error ? error.message : 'Invalid MCP input.',
      },
    });
  }
}
export function registerOntologyCommand(program: Command): void {
  const group = program
    .command('ontology')
    .description('Author, validate, and exchange customer ontologies');
  const command = (name: string, description: string) =>
    group
      .command(name)
      .description(description)
      .option('--project-root <path>', 'Project root')
      .option('--json', 'JSON output')
      .option('--yaml', 'YAML output')
      .hook('preAction', (_command, action) => {
        const global = program.opts();
        for (const key of ['projectRoot', 'json', 'yaml']) {
          if (action.opts()[key] === undefined && global[key] !== undefined) {
            action.setOptionValue(key, global[key]);
          }
        }
      });
  command('list', 'List ontology and mapping files').action(async (opts: Options) =>
    run('ontology_list', {}, opts)
  );
  command('describe [name]', 'Read exact ontology definitions')
    .option('--concept <name>', 'Exact concept name')
    .option('--limit <count>', 'Maximum concepts', '50')
    .action(async (name: string | undefined, opts: Options) =>
      run(
        'ontology_describe',
        {
          ...(name ? { ontology: name } : {}),
          ...(opts.concept ? { concept: opts.concept } : {}),
          limit: Number(opts.limit),
        },
        opts
      )
    );
  command('validate', 'Validate definitions without querying data')
    .option('--strict', 'Fail on unverified checks')
    .action(async (opts: Options) =>
      run('ontology_validate', { strict: opts.strict ?? false }, opts)
    );
  command('create <path> <input>', 'Preview creation from a native YAML file')
    .option('--apply', 'Write the new file')
    .action(async (path: string, input: string, opts: Options) =>
      run(
        'ontology_edit',
        { path, content: stringify(readConversionInput(input)), apply: opts.apply ?? false },
        opts
      )
    );
  command('edit <path> <patch>', 'Preview a patch from a YAML or JSON file')
    .option('--apply', 'Apply the patch')
    .action(async (path: string, patch: string, opts: Options) =>
      run(
        'ontology_edit',
        { path, patch: readConversionInput(patch), apply: opts.apply ?? false },
        opts
      )
    );
  command('delete <path>', 'Preview deletion and affected references')
    .option('--apply', 'Delete the file')
    .action(async (path: string, opts: Options) =>
      run('ontology_edit', { path, delete: true, apply: opts.apply ?? false }, opts)
    );
  command('import <inputs...>', 'Preview native files from Ossie documents')
    .option('--connection <name>', 'Explicit connection for imported sources')
    .action(async (inputs: string[], opts: Options) =>
      run(
        'ontology_import',
        {
          documents: inputs.map((path) => ({ path, document: readConversionInput(path) })),
          ...(opts.connection ? { defaultConnection: opts.connection } : {}),
        },
        opts
      )
    );
  command('export', 'Preview Ossie ontology documents')
    .option('--ossie-version <version>', 'Required ontology target: 0.2.0.dev0', '0.1.1')
    .option('--strict', 'Reject lossy conversion')
    .option('--out <directory>', 'Write into a new directory')
    .action(async (opts: Options) =>
      run(
        'ontology_export',
        { ossieVersion: opts.ossieVersion, strict: opts.strict ?? false },
        opts
      )
    );
  command('serve', 'Serve config-only ontology MCP tools over local stdio')
    .option('--allow-write', 'Permit file changes through MCP; previews are always available')
    .action(serveOntologyMcp);
}
