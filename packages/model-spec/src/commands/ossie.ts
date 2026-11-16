import type { Command } from 'commander';
import { basename, resolve } from 'node:path';
import { scanProject, assertValidProjectIndex } from '@bobsled-inc/project-index';
import {
  importOssieDocuments,
  exportOssieDocument,
  parseOssieYaml,
  type OssieExportSelection,
  type OssieVersion,
  type ImportOssieDocumentsRequest,
} from '../interchange/index.js';
import {
  readConversionText,
  writeConversionFile,
  writeConversionFiles,
} from '../interchange/files.js';
import { diagnostic, errorMessage, record, type ConversionResult } from '../interchange/common.js';
import * as out from '../output.js';
import { CommandError } from '../errors.js';
import { resolveOssieExportAddresses } from '../api/ossie-export-addresses.js';
import { readOssieProfile } from '../ossie/profiles.js';
import { resolveIndexedIntegrationByHandle } from '../integrations.js';

interface Options {
  out?: string;
  yaml?: boolean;
  json?: boolean;
  human?: boolean;
  strict?: boolean;
  connection?: string;
  bind?: string[];
  mapConnection?: string[];
  project?: string;
  name?: string;
  all?: boolean;
  ossieVersion?: OssieVersion;
}
function report(
  result: ConversionResult,
  options: Options,
  writer: (result: ConversionResult, path: string) => void
): void {
  if ([options.human, options.json, options.yaml].filter(Boolean).length > 1) {
    throw new Error('Choose one of --human, --json, or --yaml');
  }
  const strictWarning =
    options.strict && result.diagnostics.some((entry) => entry.severity === 'warning');
  if (options.out && result.ok && !strictWarning) writer(result, options.out);
  if (options.human) {
    const lines = [
      `${result.ready ? 'Ready' : result.ok ? 'Needs repair' : 'Failed'}: ${result.files.length} generated file(s)`,
      ...result.files.map((item) => `  ${item.path}`),
      ...result.diagnostics.map(
        (entry) =>
          `${entry.severity.toUpperCase()} ${entry.code} ${entry.path}: ${entry.message} Remedy: ${entry.remedy}`
      ),
    ];
    out.text(`${lines.join('\n')}\n`);
  } else if (options.yaml) out.yaml(result);
  else out.json(result);
  if (!result.ok || !result.ready) process.exitCode = 2;
}
async function handle(
  action: () => ConversionResult | Promise<ConversionResult>,
  options: Options,
  writer = writeConversionFiles
): Promise<void> {
  try {
    report(await action(), options, writer);
  } catch (error) {
    const result: ConversionResult = {
      ok: false,
      ready: false,
      files: [],
      diagnostics: [diagnostic('conversion_failed', 'input', errorMessage(error))],
    };
    if (options.human) {
      out.text(`Failed: ${result.diagnostics[0]?.message ?? 'Conversion failed'}\n`);
    } else if (options.yaml) out.yaml(result);
    else out.json(result);
    process.exitCode =
      error instanceof CommandError
        ? error.exitCode
        : error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string' &&
            error.code.startsWith('E')
          ? 1
          : 2;
  }
}

function ossieVersion(value: string): OssieVersion {
  if (value === '0.1.1' || value === '0.2.0.dev0') return value;
  throw new CommandError('--ossie-version must be 0.1.1 or 0.2.0.dev0', 2);
}

interface ExportDatasetEntry {
  kind: 'source' | 'model';
  path: string;
  document: Record<string, unknown>;
  reference: string;
}

function exportSelection(
  values: string[],
  all: boolean | undefined,
  datasets: readonly ExportDatasetEntry[]
): { selection: OssieExportSelection; selected: ExportDatasetEntry[] } {
  if (all && values.length) {
    throw new CommandError('Use --all or explicit selectors, not both', 2);
  }
  if (all) return { selection: { all: true }, selected: [...datasets] };
  if (!values.length) {
    throw new CommandError('Supply at least one selector or use --all', 2);
  }
  const selectors: Exclude<OssieExportSelection, { all: true }>['selectors'] = [];
  const selected = new Map<string, ExportDatasetEntry>();
  for (const value of values) {
    let matches: ExportDatasetEntry[];
    if (value.startsWith('model:')) {
      const name = value.slice('model:'.length);
      matches = datasets.filter((entry) => entry.kind === 'model' && entry.reference === name);
    } else if (value.startsWith('source:')) {
      const reference = value.slice('source:'.length);
      matches = datasets.filter(
        (entry) => entry.kind === 'source' && entry.reference === reference
      );
    } else {
      matches = datasets.filter((entry) => entry.document['name'] === value);
    }
    if (matches.length !== 1) {
      throw new CommandError(
        `${value}: selector ${matches.length ? 'is ambiguous' : 'did not match a source or model'}. Use model:<name> or source:<connection>.<name>.`,
        2
      );
    }
    const match = matches[0]!;
    selected.set(`${match.kind}:${match.reference}`, match);
    if (match.kind === 'model') {
      selectors.push({ kind: 'model', name: String(match.document['name']) });
    } else {
      selectors.push({
        kind: 'source',
        connection: String(match.document['connection']),
        name: String(match.document['name']),
      });
    }
  }
  return { selection: { selectors }, selected: [...selected.values()] };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function pair(value: string, label: string): [string, string] {
  const split = value.lastIndexOf('=');
  if (split <= 0 || split === value.length - 1) {
    throw new CommandError(`${label} must use <left>=<right>`, 2);
  }
  return [value.slice(0, split), value.slice(split + 1)];
}

async function importRequest(
  paths: string[],
  options: Options
): Promise<ImportOssieDocumentsRequest> {
  const documents = paths.map((path) => ({ path, content: readConversionText(path) }));
  const locations = documents.flatMap((document) =>
    readOssieProfile(
      parseOssieYaml(document.content, document.path),
      document.path
    ).semanticModels.flatMap((model) =>
      model.datasets.map((dataset) => ({ path: document.path, dataset: dataset.name }))
    )
  );
  const datasetBindings = (options.bind ?? []).map((value) => {
    const [selector, connection] = pair(value, '--bind');
    const hash = selector.lastIndexOf('#');
    const candidates =
      hash >= 0
        ? locations.filter(
            (location) =>
              (location.path === selector.slice(0, hash) ||
                basename(location.path) === selector.slice(0, hash)) &&
              location.dataset === selector.slice(hash + 1)
          )
        : locations.filter((location) => location.dataset === selector);
    if (candidates.length !== 1) {
      throw new CommandError(
        `${value}: dataset binding ${candidates.length ? 'is ambiguous' : 'did not match a dataset'}. Use <file>#<dataset>=<connection>.`,
        2
      );
    }
    return { documentPath: candidates[0]!.path, dataset: candidates[0]!.dataset, connection };
  });
  const connectionAliases = Object.fromEntries(
    (options.mapConnection ?? []).map((value) => pair(value, '--map-connection'))
  );
  if (options.project) {
    const index = await scanProject(resolve(options.project));
    assertValidProjectIndex(index);
    const handles = new Set([
      ...(options.connection ? [options.connection] : []),
      ...datasetBindings.map((binding) => binding.connection),
      ...Object.values(connectionAliases),
    ]);
    for (const handle of handles) resolveIndexedIntegrationByHandle(index, handle);
  }
  return {
    documents,
    context: {
      connections: {
        ...(options.connection ? { defaultConnection: options.connection } : {}),
        ...(datasetBindings.length ? { datasetBindings } : {}),
        ...(Object.keys(connectionAliases).length ? { connectionAliases } : {}),
      },
    },
    options: { strict: options.strict },
  };
}

export function registerOssieCommand(program: Command): void {
  const command = program
    .command('ossie')
    .description('Import/export Ossie using native Dogsled files and BOBSLED extensions');
  command
    .command('import <files...>')
    .description(
      'Preview native files; --out writes to a new directory (incomplete drafts remain invalid)'
    )
    .option('--connection <handle>', 'Default connection for unresolved sources')
    .option('--bind <dataset=handle>', 'Bind one dataset to a connection', collect, [])
    .option('--map-connection <old=new>', 'Map an imported connection handle', collect, [])
    .option('--project <directory>', 'Validate connection handles against a Dogsled project')
    .option('--out <directory>', 'New output directory; existing paths are never overwritten')
    .option('--strict', 'Block readiness and writes when the conversion loses meaning')
    .option('--human', 'Readable conversion report')
    .option('--json', 'JSON conversion report (default)')
    .option('--yaml', 'YAML conversion report')
    .action(async (paths: string[], options: Options) =>
      handle(async () => importOssieDocuments(await importRequest(paths, options)), options)
    );
  command
    .command('export [selectors...]')
    .description('Convert selected native sources and models to one Ossie YAML document')
    .option('--project <directory>', 'Native Dogsled project directory', '.')
    .requiredOption('--name <name>', 'Ossie semantic model name')
    .option('--all', 'Export every supported source and model')
    .option(
      '--ossie-version <version>',
      'Ossie version: 0.1.1 (default) or 0.2.0.dev0',
      ossieVersion,
      '0.1.1'
    )
    .option('--out <file>', 'New YAML file; existing paths are never overwritten')
    .option('--strict', 'Block writes when the conversion loses meaning')
    .option('--human', 'Readable conversion report')
    .option('--json', 'JSON conversion report (default)')
    .option('--yaml', 'YAML conversion report')
    .action(async (selectors: string[], options: Options) =>
      handle(
        async () => {
          const index = await scanProject(resolve(options.project ?? '.'));
          assertValidProjectIndex(index);
          const datasets: ExportDatasetEntry[] = index.entries.flatMap((entry) => {
            if (entry.kind !== 'source' && entry.kind !== 'model') return [];
            const document = record(entry.document);
            const name = String(document['name']);
            return [
              {
                kind: entry.kind,
                path: entry.path,
                document,
                reference:
                  entry.kind === 'source' ? `${String(document['connection'])}.${name}` : name,
              },
            ];
          });
          const chosen = exportSelection(selectors, options.all, datasets);
          const inputs = chosen.selected.map((entry) => ({
            path: entry.path,
            document: entry.document,
          }));
          const addresses = await resolveOssieExportAddresses(
            resolve(options.project ?? '.'),
            index,
            inputs
          );
          const documents = (kind: string) =>
            index.entries.filter((entry) => entry.kind === kind).map((entry) => entry.document);
          return exportOssieDocument({
            project: {
              sources: documents('source'),
              models: documents('model'),
              metrics: documents('metric'),
              relationships: documents('relationship'),
              verifiedQueries: documents('vq'),
              addresses,
            },
            semanticModelName: options.name!,
            selection: chosen.selection,
            ossieVersion: options.ossieVersion,
            strict: options.strict,
          });
        },
        options,
        writeConversionFile
      )
    );
}
