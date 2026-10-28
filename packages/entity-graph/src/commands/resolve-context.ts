import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommandError } from '@bobsled-inc/protocol';
import { resolveProjectIndex } from '@bobsled-inc/project-index';
import {
  buildIndexedSourceRegistry,
  type SourceColumnRegistry,
  type SourceRegistry,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import {
  loadProjectConfig,
  out,
  parseGlobalFlags,
  resolveConfig,
} from '@bobsled-inc/model-spec/shared';
import type { ProjectConfig } from '@bobsled-inc/model-spec/project';
import { discoverResolutionSpecs, resolveResolutionSpec } from '../compiler/identity/parser.js';
import type { ResolvedResolutionSpec } from '../compiler/identity/types.js';

export interface ResolveContext {
  specs: ResolvedResolutionSpec[];
  dialect: SupportedDialect;
  targetSchema: string;
  entityGraphDir: string;
  /** The project's Model Spec configuration, read once for every step of the command. */
  config: ProjectConfig | null;
  verbose: boolean;
  quiet: boolean;
}

/** Load config-backed resolution specs and normalize them for command handlers. */
export function buildResolveContext(
  globalOptions: { verbose?: boolean; quiet?: boolean },
  localOptions: { dialect?: string; schema?: string },
  entityNames: string[]
): ResolveContext {
  const flags = parseGlobalFlags(globalOptions);
  const cwd = process.cwd();

  const index = resolveProjectIndex(cwd);
  const { config } = loadProjectConfig(cwd, { index });

  const resolved = resolveConfig(
    {
      dialect: localOptions.dialect as SupportedDialect | undefined,
      schema: localOptions.schema,
    },
    config
  );

  const dialect = resolved.dialect;
  const targetSchema = resolved.schema;

  const registryResult = buildIndexedSourceRegistry(index);
  if (!registryResult.ok) {
    throw new CommandError(registryResult.error, 2);
  }
  const sourceRegistry: SourceRegistry = registryResult.registry;
  const columnRegistry: SourceColumnRegistry | undefined = registryResult.columnRegistry;

  const entityGraphDir = path.join(cwd, resolved.entityGraphDir);
  if (!fs.existsSync(entityGraphDir)) {
    throw new CommandError(
      `No ${resolved.entityGraphDir}/ directory found. Create it with resolution spec YAML files.`,
      2
    );
  }

  const parsedSpecs = discoverResolutionSpecs(entityGraphDir);
  if (parsedSpecs.length === 0) {
    throw new CommandError(`No resolution specs found in ${resolved.entityGraphDir}/.`, 2);
  }

  for (const p of parsedSpecs) {
    for (const w of p.warnings ?? []) out.warn(w);
  }

  let resolvedSpecs = parsedSpecs.map((p) =>
    resolveResolutionSpec(p, sourceRegistry, dialect, targetSchema, columnRegistry)
  );

  if (entityNames.length > 0) {
    resolvedSpecs = resolvedSpecs.filter(
      (s) => entityNames.includes(s.entity) || entityNames.includes(s.name)
    );
    if (resolvedSpecs.length === 0) {
      throw new CommandError(`No resolution specs found matching: ${entityNames.join(', ')}`, 2);
    }
  }

  return {
    specs: resolvedSpecs,
    dialect,
    targetSchema,
    entityGraphDir,
    config,
    verbose: flags.verbose,
    quiet: flags.quiet,
  };
}
