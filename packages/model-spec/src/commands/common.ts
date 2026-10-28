/**
 * Shared command setup utilities.
 *
 * Extracts common boilerplate from compile, run, test, lineage commands.
 * `buildCompileContext` is async and derives `dialect` +
 * `targetSchema` from the active integration declared under
 * `integrations/<handle>.yml` — the legacy `--dialect` / `--schema` flags
 * have been removed from the Model Spec CLI. Entity Graph CLI still accepts them; it calls
 * `resolveConfig` directly (re-exported from `../config.js`) rather than
 * through this helper.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  entriesOfKind,
  entryFilePath,
  resolveProjectIndex,
  type ProjectIndex,
} from '@bobsled-inc/project-index';
import { InvalidArgumentError, Option } from 'commander';

import {
  buildDagFromDocuments,
  buildIndexedSourceRegistry,
  filterDagByIntegration,
  filterSourceEntryRegistry,
  filterSourceRegistry,
  inferDagIntegrations,
  isSupportedDialect,
  SUPPORTED_DIALECTS,
  trackEphemeralModel,
  withEphemeralAncestors,
} from '../compiler/index.js';
import { expandOssieIndex } from '../ossie/index.js';
import { registerOssieBindings, validateOssiePublishBindings } from '../api/ossie-bindings.js';
import { resolveSelection } from '../selection.js';
import { loadProjectConfig, resolveConfig } from '../config.js';
import {
  pickIntegrationsByHandle,
  resolveIndexedIntegrations,
  validateSourceIntegrationRefs,
  type ResolvedIntegration,
} from '../integrations.js';
import * as out from '../output.js';

import {
  buildIntegrationContext,
  validateSchema,
  type DagContext,
  type IntegrationCompileContext,
} from '../api/integration-context.js';

import type {
  ModelRegistry,
  SqlQueryRunner,
  SqlRunner,
  SqlRunnerModule,
  SupportedDialect,
} from '../compiler/index.js';

// Re-export for commands that import from common.ts
export { trackEphemeralModel };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SCHEMA = 'PUBLIC';
export const DEFAULT_DIALECT: SupportedDialect = 'snowflake';
export const SOURCES_DIR = 'sources';
export const MODELS_DIR = 'models';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface GlobalFlags {
  verbose: boolean;
  quiet: boolean;
  json: boolean;
}

export interface CommandContext {
  cwd: string;
  /** Type index of the project in `cwd`, shared by every loader in the command. */
  index: ProjectIndex;
  verbose: boolean;
  quiet: boolean;
  json: boolean;
}

export type ResolvedConfig = ReturnType<typeof resolveConfig>;

// Re-exported so existing imports from `./common.js` keep working.
export { buildIntegrationContext, validateSchema };
export type { DagContext, IntegrationCompileContext };

interface RunnerModuleObject {
  run?: unknown;
  query?: unknown;
  close?: unknown;
}

interface RunnerModuleNamespace extends RunnerModuleObject {
  default?: unknown;
}

// Re-exported so existing `import { CommandError } from './common.js'` keeps working.
export { CommandError } from '../errors.js';
import { CommandError } from '../errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scaffoldNameRegex = /^[A-Za-z0-9_-]+$/;

/** Validate scaffold/entity names used in file paths and YAML stubs. */
export function validateScaffoldName(value: string, label: string): string {
  if (!scaffoldNameRegex.test(value)) {
    throw new CommandError(
      `${label} must contain only letters, numbers, underscores, and hyphens.`,
      2
    );
  }
  return value;
}

/** Resolve a path under a root directory and reject traversal outside that root. */
export function resolvePathWithinDir(rootDir: string, relativePath: string, label: string): string {
  const rootPath = path.resolve(rootDir);
  const resolvedPath = path.resolve(rootDir, relativePath);
  const rel = path.relative(rootPath, resolvedPath);
  const escapesRoot = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (escapesRoot) {
    throw new CommandError(`${label} resolves outside ${rootPath}.`, 2);
  }
  return resolvedPath;
}

/** Resolve the default JSON output mode from environment and terminal context. */
function resolveJsonDefault(): boolean {
  const outputFormat = process.env['DOGSLED_OUTPUT_FORMAT']?.trim().toLowerCase();
  if (outputFormat === 'json') return true;
  if (outputFormat === 'text') return false;
  if (process.env['CI'] === '1' || process.env['CI'] === 'true') return true;
  return !process.stdout.isTTY;
}

/** Extract global flags from program options and output environment. */
export function parseGlobalFlags(opts: {
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
}): GlobalFlags {
  return {
    verbose: opts.verbose ?? false,
    quiet: opts.quiet ?? false,
    json: opts.json ?? resolveJsonDefault(),
  };
}

/**
 * @deprecated Retained for Entity Graph compatibility — Model Spec commands no longer expose
 * `--dialect`. Entity Graph will migrate to `--integration` in a follow-up PR.
 */
export function createDialectOption(): Option {
  return new Option('--dialect <name>', 'Compiler target').choices([...SUPPORTED_DIALECTS]);
}

/** Create the standard `--integration <handle>` option for Commander. */
export function createIntegrationOption(): Option {
  return new Option(
    '--integration <handle>',
    'Active integration handle (the name of a type: integration file; required when more than one integration is defined)'
  );
}

/** Parse a CLI option value as a non-negative integer; throws InvalidArgumentError on bad input. */
export function parsePositiveIntOption(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new InvalidArgumentError('must be a non-negative integer');
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidArgumentError('must be a non-negative integer within safe integer range');
  }
  return Number(parsed);
}

/** Parse a CLI option value as a confidence threshold in [0, 1]. */
export function parseConfidenceOption(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError('must be a number between 0 and 1');
  }
  return parsed;
}

/** Validate that a result is ok, or throw CommandError. */
export function assertOk<T extends { ok: true }>(
  result: T | { ok: false; error: string },
  exitCode = 2
): asserts result is T {
  if (!result.ok) {
    throw new CommandError(result.error, exitCode);
  }
}

/**
 * Build command context: scan the project in the current directory once and
 * index its files by declared type. Malformed or unknown project files fail
 * here with exit code 2, naming each file.
 */
export function buildCommandContext(globalFlags: GlobalFlags): CommandContext {
  const cwd = process.cwd();
  return { cwd, index: expandOssieIndex(resolveProjectIndex(cwd)), ...globalFlags };
}

/**
 * Load project config and build command context. Returns the parsed
 * ResolvedConfig so commands can access `seedsDir`, `checkpointStore`, etc.
 *
 * No dialect/schema CLI flags are threaded through — those now come from the
 * active integration.
 */
export function buildCommandContextWithConfig(globalFlags: GlobalFlags): {
  ctx: CommandContext;
  resolved: ResolvedConfig;
} {
  const ctx = buildCommandContext(globalFlags);
  const { config } = loadProjectConfig(ctx.cwd, { index: ctx.index });
  return { ctx, resolved: resolveConfig({}, config) };
}

/**
 * Build source registry, DAG, and optionally filter to a subgraph.
 * Throws CommandError on validation errors.
 */
export function buildDagContext(
  ctx: CommandContext,
  modelNames: string[]
): DagContext & { allNodes: DagContext['orderedNodes'] } {
  const index = expandOssieIndex(ctx.index);
  // Build source registry
  out.debug('Building source registry...', ctx.verbose);
  const registryResult = buildIndexedSourceRegistry(index);
  assertOk(registryResult);
  const { registry, entryRegistry } = registryResult;
  out.debug(`Found ${registry.size} source(s).`, ctx.verbose);

  // Collect model files and build DAG
  const modelDocuments = entriesOfKind(index, 'model').map((entry) => ({
    filePath: entryFilePath(index, entry),
    data: entry.document,
  }));
  if (modelDocuments.length === 0) {
    const filterMsg = modelNames.length > 0 ? ` matching: ${modelNames.join(', ')}` : '';
    throw new CommandError(`No model files found${filterMsg}.`);
  }

  out.debug('Building DAG...', ctx.verbose);
  const dagResult = buildDagFromDocuments(modelDocuments);
  assertOk(dagResult);
  registerOssieBindings(index, dagResult.order, entryRegistry);

  // Filter to the requested selection. dbt-style exact selection: a bare name
  // resolves to EXACTLY that model (no upstream closure); `+X`/`X+`/`+X+`/`tag:`
  // opt into graph expansion. `resolveSelection` throws on an unknown name; the
  // empty guard below only fires when every selector resolves to nothing.
  let orderedNodes = dagResult.order;
  if (modelNames.length > 0) {
    const selected = new Set(
      resolveSelection(
        dagResult.order.map((node) => ({
          name: node.name,
          refs: node.refs,
          tags: node.parsedSpec.model_kind === 'agentic' ? [] : node.parsedSpec.tags,
        })),
        modelNames
      )
    );
    orderedNodes = withEphemeralAncestors(dagResult.order, selected);
  }

  if (orderedNodes.length === 0) {
    throw new CommandError(`No models found matching: ${modelNames.join(', ')}`);
  }

  out.debug(`Compilation order: ${orderedNodes.map((n) => n.name).join(' → ')}`, ctx.verbose);

  // `allNodes` is the FULL project model set — callers build the model registry
  // from it so a selected model's `ref` to an unselected upstream still resolves
  // to that upstream's physical table.
  return { orderedNodes, allNodes: dagResult.order, registry, entryRegistry };
}

// ---------------------------------------------------------------------------
// Compile context
// ---------------------------------------------------------------------------

export interface CompileContext extends DagContext {
  ctx: CommandContext;
  dialect: SupportedDialect;
  targetSchema: string;
  /** Target database for DDL generation — only set when the active integration defines one. */
  targetDatabase?: string;
  /** Which integration this compile targets. Surfaced for output layout (`target/<integration>/`). */
  integration: ResolvedIntegration;
  modelReg: ModelRegistry;
  /** Fully-resolved project config — directory overrides, dialect, schema. */
  resolved: ResolvedConfig;
}

/**
 * Result of `buildMultiCompileContext`. The shared command/config pieces
 * live at the top level; every active integration gets its own
 * `IntegrationCompileContext` in `perIntegration`. Callers loop over that
 * list and run their existing per-integration body inside.
 */
export interface MultiCompileContext {
  ctx: CommandContext;
  resolved: ResolvedConfig;
  perIntegration: IntegrationCompileContext[];
}

/**
 * One-call setup: global flags → project config → active integrations → DAG →
 * per-integration subgraphs + model registries. Used by every Model Spec command
 * that generates SQL (compile, run, test, validate, lineage).
 *
 * Behavior:
 *   - With `--integration <handle>` explicit: narrows to that one integration
 *     and uniformly stamps every model with the handle. Preserves V0 behavior
 *     for projects whose source `connection:` handles are a logical namespace
 *     independent from the integration selection.
 *   - Without `--integration`: infers each model's integration from source
 *     refs + transitive upstream models, then fans out one context per
 *     integration that has at least one model. Models that mix handles throw
 *     a CommandError(2).
 */
export async function buildMultiCompileContext(
  globalOptions: { verbose?: boolean; quiet?: boolean },
  localOptions?: { integration?: string },
  modelNames?: string[]
): Promise<MultiCompileContext> {
  const flags = parseGlobalFlags(globalOptions);
  const { ctx, resolved } = buildCommandContextWithConfig(flags);

  const all = resolveIndexedIntegrations(ctx.index);
  const selected = pickIntegrationsByHandle(all, localOptions?.integration);

  // Build the source registry + DAG once. `buildDagContext` applies the
  // selection up-front so `fullOrderedNodes` is the EXECUTION set, while
  // `allNodes` is the FULL project model set used to resolve refs to physical
  // tables (so an exact selection's ref to an unselected upstream still
  // resolves).
  const {
    orderedNodes: fullOrderedNodes,
    allNodes,
    registry,
    entryRegistry,
  } = buildDagContext(ctx, modelNames ?? []);

  // Cross-reference every source's connection handle against declared
  // integrations. Running *after* the DAG build keeps the existing
  // "unknown-ref" / "missing models" messaging intact for projects that fail
  // earlier.
  validateOssiePublishBindings(allNodes, all);
  const knownHandles = new Set(all.keys());
  validateSourceIntegrationRefs(registry.keys(), knownHandles);

  // Infer each DAG node's owning integration from its source refs + transitive
  // upstream models. Enforces the per-model mixed-handle invariant. Runs over
  // the FULL set (`allNodes`) so every model — including unselected upstreams
  // used only for ref resolution — is stamped; `fullOrderedNodes` shares the
  // same node objects, so it is stamped too.
  try {
    inferDagIntegrations(allNodes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(message, 2);
  }

  const explicitHandle = localOptions?.integration;
  const perIntegration: IntegrationCompileContext[] = [];

  if (explicitHandle !== undefined) {
    // Explicit-handle path. `pickIntegrationsByHandle` guarantees length 1.
    const integration = selected[0] as ResolvedIntegration;
    const scopedNodes = filterDagByIntegration(fullOrderedNodes, explicitHandle);
    if (scopedNodes.length > 0) {
      // Filter mode: at least one model's source `connection:` handle matches
      // the requested integration. Only those models get compiled; the registry
      // sees every model on the handle so refs to unselected ones resolve.
      const scopedRegistry = filterSourceRegistry(registry, explicitHandle);
      const scopedEntryRegistry = filterSourceEntryRegistry(entryRegistry, explicitHandle);
      perIntegration.push(
        buildIntegrationContext(
          integration,
          scopedNodes,
          scopedRegistry,
          scopedEntryRegistry,
          filterDagByIntegration(allNodes, explicitHandle)
        )
      );
    } else {
      // Uniform-stamp fallback: sources use a logical namespace that doesn't
      // match the requested integration (e.g. `connection: ecom` while the
      // user picks `--integration snowflake` to target a dialect). Preserve
      // V0 semantics and compile every model through this integration. Stamp
      // the full set so the registry (built from `allNodes`) is stamped too;
      // `fullOrderedNodes` shares the same node objects.
      for (const node of allNodes) {
        node.integration = explicitHandle;
      }
      perIntegration.push(
        buildIntegrationContext(integration, fullOrderedNodes, registry, entryRegistry, allNodes)
      );
    }
  } else {
    // No explicit handle: fan out. One context per inferred integration.
    for (const integration of selected) {
      const integrationNodes = filterDagByIntegration(fullOrderedNodes, integration.handle);
      if (integrationNodes.length === 0) {
        out.warn(
          `Integration "${integration.handle}" declared but no models reference it — skipping.`
        );
        continue;
      }
      const scopedRegistry = filterSourceRegistry(registry, integration.handle);
      const scopedEntryRegistry = filterSourceEntryRegistry(entryRegistry, integration.handle);
      perIntegration.push(
        buildIntegrationContext(
          integration,
          integrationNodes,
          scopedRegistry,
          scopedEntryRegistry,
          filterDagByIntegration(allNodes, integration.handle)
        )
      );
    }
  }

  return { ctx, resolved, perIntegration };
}

/**
 * Single-integration wrapper retained for callers that still want one
 * `CompileContext` (lineage, Entity Graph). Asserts exactly one integration resolves,
 * throwing if multiple are declared without `--integration`.
 */
export async function buildCompileContext(
  globalOptions: { verbose?: boolean; quiet?: boolean },
  localOptions?: { integration?: string },
  modelNames?: string[]
): Promise<CompileContext> {
  const multi = await buildMultiCompileContext(globalOptions, localOptions, modelNames);

  if (multi.perIntegration.length === 0) {
    throw new CommandError(
      `No integrations produced a compile context — check that models reference sources from a declared integration.`,
      2
    );
  }

  if (multi.perIntegration.length > 1) {
    const handles = multi.perIntegration.map((i) => i.integration.handle).join(', ');
    throw new CommandError(
      `Multiple integrations resolved (${handles}). Pass --integration <handle> to pick one.`,
      2
    );
  }

  const only = multi.perIntegration[0] as IntegrationCompileContext;
  return {
    ctx: multi.ctx,
    resolved: multi.resolved,
    dialect: only.dialect,
    targetSchema: only.targetSchema,
    targetDatabase: only.targetDatabase,
    integration: only.integration,
    modelReg: only.modelReg,
    orderedNodes: only.orderedNodes,
    registry: only.registry,
    entryRegistry: only.entryRegistry,
  };
}

/** Preserve isSupportedDialect export so callers don't need to reach into compiler/. */
export { isSupportedDialect };

/** Load a runner module from disk and normalize default/named exports. */
export async function loadRunnerModule(runnerPath: string): Promise<SqlRunnerModule> {
  const resolvedPath = path.resolve(runnerPath);
  const runnerRef = path.isAbsolute(runnerPath) ? path.basename(runnerPath) : runnerPath;

  if (!fs.existsSync(resolvedPath)) {
    throw new CommandError(`Runner module not found: ${runnerRef}`, 1);
  }

  const realResolvedPath = fs.realpathSync.native(resolvedPath);

  try {
    const mod = (await import(pathToFileURL(resolvedPath).href)) as RunnerModuleNamespace;
    const { default: defaultExport, run: namedRun, query: namedQuery, close: namedClose } = mod;
    const close = typeof namedClose === 'function' ? namedClose : undefined;

    if (typeof defaultExport === 'function') {
      return {
        run: defaultExport as SqlRunner,
        query: typeof namedQuery === 'function' ? (namedQuery as SqlQueryRunner) : undefined,
        close: close as SqlRunnerModule['close'],
      };
    }

    if (defaultExport && typeof defaultExport === 'object') {
      const {
        run: defaultRun,
        query: defaultQuery,
        close: defaultClose,
      } = defaultExport as RunnerModuleObject & { close?: unknown };
      if (typeof defaultRun === 'function') {
        return {
          run: defaultRun as SqlRunner,
          query:
            typeof defaultQuery === 'function'
              ? (defaultQuery as SqlQueryRunner)
              : typeof namedQuery === 'function'
                ? (namedQuery as SqlQueryRunner)
                : undefined,
          close:
            typeof defaultClose === 'function'
              ? (defaultClose as SqlRunnerModule['close'])
              : (close as SqlRunnerModule['close']),
        };
      }
    }

    if (typeof namedRun === 'function') {
      return {
        run: namedRun as SqlRunner,
        query: typeof namedQuery === 'function' ? (namedQuery as SqlQueryRunner) : undefined,
        close: close as SqlRunnerModule['close'],
      };
    }
  } catch (err) {
    const rawMsg =
      err instanceof Error
        ? (err.message.split('\n')[0] ?? 'Module load failed')
        : 'Module load failed';
    const runnerDir = path.dirname(resolvedPath);
    const realRunnerDir = path.dirname(realResolvedPath);
    const safeMsg = rawMsg
      .replaceAll(pathToFileURL(resolvedPath).href, '<runner>')
      .replaceAll(resolvedPath, '<runner>')
      .replaceAll(pathToFileURL(realResolvedPath).href, '<runner>')
      .replaceAll(realResolvedPath, '<runner>')
      .replaceAll(pathToFileURL(runnerDir).href, '<runner-dir>')
      .replaceAll(runnerDir, '<runner-dir>')
      .replaceAll(pathToFileURL(realRunnerDir).href, '<runner-dir>')
      .replaceAll(realRunnerDir, '<runner-dir>')
      .replaceAll('/private<runner>', '<runner>');
    throw new CommandError(`Failed to load runner "${runnerRef}": ${safeMsg}`, 1);
  }

  throw new CommandError(
    `Runner module "${runnerRef}" must export a default or "run" function.`,
    1
  );
}
