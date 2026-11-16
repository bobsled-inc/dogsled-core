import type { ProjectIndex } from '@bobsled-inc/project-index';

import type { ModelSpec } from '../agentic/model.js';
import type { DagNode } from '../compiler/dag.js';
import { analyzeModelDependencies } from '../compiler/model-dependency-analysis.js';
import type { SourceEntryRegistry } from '../compiler/parser.js';
import type { ModelRegistry } from '../compiler/parser.js';
import { buildFqNameWithDatabase } from '../compiler/dialect.js';
import {
  getPublishTarget,
  getPublishTargetSchema,
  getPublishTargetDatabase,
} from '../compiler/publish-execution.js';
import type { ResolvedIntegration } from '../integrations.js';
import type { SupportedDialect } from '../compiler/dialect.js';
import { CommandError } from '../errors.js';
import { getOssieOrigins } from '../ossie/index.js';
import { isOssieLocalUri } from '../interchange/common.js';

// Parsed specs survive integration selection (which copies DAG nodes). Keeping
// bindings beside them avoids adding authoring-format fields to runtime specs.
const bindings = new WeakMap<ModelSpec, { source: string; filePath: string }>();

export function registerOssieBindings(
  index: ProjectIndex,
  nodes: readonly DagNode[],
  sourceEntries: SourceEntryRegistry
): void {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const localOrigins = getOssieOrigins(index).filter(
    (origin) => origin.kind === 'derived' && isOssieLocalUri(origin.source)
  );
  if (localOrigins.length > 0) {
    const analysis = analyzeModelDependencies({
      models: nodes.map((node) => node.parsedSpec),
      sourceEntries,
    });
    if (!analysis.ok) throw new CommandError(analysis.error, 2);
    for (const origin of localOrigins) {
      const node = byName.get(origin.name.toLowerCase());
      const dependency = analysis.analyses.find(
        (value) => value.modelName.toLowerCase() === origin.name.toLowerCase()
      );
      if (node && node.materialization !== 'ephemeral' && dependency?.executionMode !== 'on_read') {
        throw new CommandError(
          `${origin.filePath}: Ossie dataset "${origin.name}" uses a Bobsled Core query reference but has no live source and is not ephemeral. Use the finished warehouse address.`,
          2
        );
      }
    }
  }
  for (const origin of getOssieOrigins(index)) {
    if (origin.kind !== 'derived') continue;
    const node = byName.get(origin.name.toLowerCase());
    if (node) bindings.set(node.parsedSpec, origin);
  }
}

/** Compare addresses, preserving case-sensitive quoted warehouse identifiers. */
function addressParts(address: string, dialect: SupportedDialect): string[] | undefined {
  // BigQuery also accepts one backtick pair around the whole address.
  if (dialect === 'bigquery' && /^`[^`]+\.[^`]+`$/.test(address)) {
    address = address.slice(1, -1);
  }
  const parts: string[] = [];
  const token = /(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|[A-Za-z_][\w$-]*)/y;
  let offset = 0;
  while (offset < address.length) {
    token.lastIndex = offset;
    const match = token.exec(address);
    if (!match) return undefined;
    const raw = match[0];
    const quoted = raw.startsWith('"') || raw.startsWith('`');
    let value = quoted
      ? raw.slice(1, -1).replaceAll(raw.charAt(0) + raw.charAt(0), raw.charAt(0))
      : raw;
    if (dialect === 'duckdb' || dialect === 'databricks') value = value.toLowerCase();
    else if (!quoted && dialect === 'snowflake') value = value.toUpperCase();
    else if (!quoted && ['postgres', 'pgvector', 'redshift'].includes(dialect)) {
      value = value.toLowerCase();
    }
    parts.push(value);
    offset = token.lastIndex;
    if (offset === address.length) break;
    if (address[offset] !== '.' || offset + 1 === address.length) return undefined;
    offset += 1;
  }
  return parts.length >= 2 ? parts : undefined;
}

export function validateOssieBindings(
  nodes: readonly DagNode[],
  modelRegistry: ModelRegistry,
  dialect: SupportedDialect,
  includePublished = false
): void {
  for (const node of nodes) {
    if (!includePublished && getPublishTarget(node.parsedSpec.publish)) continue;
    const binding = bindings.get(node.parsedSpec);
    if (!binding || isOssieLocalUri(binding.source)) continue;
    const resolved = modelRegistry.get(node.name);
    const declaredParts = addressParts(binding.source, dialect);
    const resolvedParts = resolved && addressParts(resolved, dialect);
    if (
      !declaredParts ||
      !resolvedParts ||
      declaredParts.length !== resolvedParts.length ||
      declaredParts.some((part, i) => part !== resolvedParts[i])
    ) {
      throw new CommandError(
        `${binding.filePath}: Ossie dataset "${node.name}" declares source "${binding.source}", ` +
          `but Bobsled Core resolves its output to "${resolved ?? '(unresolved)'}". ` +
          'Update the source or Bobsled Core destination settings so they identify the same table.',
        2
      );
    }
  }
}

/** Published models bind to the destination, which can differ from their engine. */
export function validateOssiePublishBindings(
  nodes: readonly DagNode[],
  integrations: ReadonlyMap<string, ResolvedIntegration>
): void {
  for (const node of nodes) {
    if (!bindings.has(node.parsedSpec)) continue;
    const handle = getPublishTarget(node.parsedSpec.publish);
    if (!handle) continue;
    const { address, dialect } = resolvePublishedModelAddress(
      node.name,
      node.parsedSpec,
      integrations
    );
    validateOssieBindings([node], new Map([[node.name, address]]), dialect, true);
  }
}

/** Shared publish-address resolution for validation and export. No warehouse I/O. */
export function resolvePublishedModelAddress(
  name: string,
  spec: ModelSpec,
  integrations: ReadonlyMap<string, ResolvedIntegration>
): { address: string; dialect: SupportedDialect } {
  const handle = getPublishTarget(spec.publish);
  if (!handle) throw new CommandError(`Model "${name}" has no publish target`, 2);
  const target = integrations.get(handle);
  if (!target) throw new CommandError(`Unknown publish integration "${handle}"`, 2);
  const schema = getPublishTargetSchema(spec.publish) ?? spec.target_schema ?? target.targetSchema;
  const database =
    getPublishTargetDatabase(spec.publish) ?? spec.target_database ?? target.targetDatabase;
  return {
    address: buildFqNameWithDatabase(schema, name, target.dialect, database),
    dialect: target.dialect,
  };
}
