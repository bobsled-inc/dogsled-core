import {
  buildInMemorySourceEntryRegistry,
  SourceSpecSchema,
  type SourceSpec,
  type SourceRegistryEntry,
} from '@bobsled-inc/model-spec';
import {
  entriesOfKind,
  entryFilePath,
  resolveProjectIndex,
  type ProjectIndex,
} from '@bobsled-inc/project-index';
import { CommandError, formatSpecValidationMessage } from '@bobsled-inc/protocol';

export type ApiResourceEntry = Extract<SourceRegistryEntry, { kind: 'api_resource' }>;

export function sourceNameOf(entry: ApiResourceEntry): string {
  const prefix = 'sources.';
  if (!entry.fqRef.startsWith(prefix)) {
    throw new CommandError(`Invalid source fqRef "${entry.fqRef}"`, 2);
  }
  const name = entry.fqRef.slice(prefix.length).trim();
  if (name.length === 0) {
    throw new CommandError(`Invalid source fqRef "${entry.fqRef}": missing source name`, 2);
  }
  return name;
}

/** Full authored source identity, with a fallback for older injected entries. */
export function sourceReferenceOf(entry: ApiResourceEntry): string {
  return entry.sourceRef ?? `${entry.connection}.${entry.sourceName ?? sourceNameOf(entry)}`;
}

function warnDeprecatedCacheMode(raw: unknown, file: string): void {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as { type?: unknown; source_type?: unknown; mode?: unknown };
  if (value.type !== 'source' || value.source_type !== 'api_resource') return;
  if (value.mode !== 'cache') return;
  process.emitWarning(`Source spec ${file} uses deprecated mode: cache; use mode: lazy instead.`, {
    code: 'BOBSLED_CORE_SOURCE_MODE_CACHE_DEPRECATED',
  });
}

/**
 * The project's API resource sources: every model source file (`type: source`)
 * in the project index, wherever it lives, keeping the `api_resource` entries.
 */
export async function loadApiResourceEntries(
  projectRoot: string,
  index?: ProjectIndex
): Promise<ApiResourceEntry[]> {
  const project = resolveProjectIndex(projectRoot, index);
  const specs: SourceSpec[] = [];

  for (const entry of entriesOfKind(project, 'source')) {
    const file = entryFilePath(project, entry);
    warnDeprecatedCacheMode(entry.document, file);
    const parsed = SourceSpecSchema.safeParse(entry.document);
    if (!parsed.success) {
      throw new CommandError(
        formatSpecValidationMessage('source', file, parsed.error, {
          schema: SourceSpecSchema,
        }),
        2
      );
    }

    specs.push(parsed.data);
  }

  const registry = buildInMemorySourceEntryRegistry(specs);
  if (!registry.ok) throw new CommandError(registry.error, 2);
  return [...registry.entryRegistry.values()].filter(
    (entry): entry is ApiResourceEntry => entry.kind === 'api_resource'
  );
}
