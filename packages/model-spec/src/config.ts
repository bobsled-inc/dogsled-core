/**
 * Project configuration file (`model-spec.yml`) support.
 *
 * Reads the project's Model Spec configuration — the file declaring
 * `type: model_spec_config`, or an untyped root `model-spec.yml` — and merges it with CLI
 * overrides. The file no longer carries `dialect` or `schema` — those come from
 * the active integration file. See `packages/connections`.
 *
 * The directory keys (`sources_dir`, `models_dir`, …) are accepted for
 * compatibility; project files are discovered by declared type anywhere in
 * the project, so they no longer limit where Model Spec objects live. `seeds_dir`
 * and `entity_graph_dir` still locate seeds and Entity Graph specs.
 *
 * `resolveConfig` still returns `dialect` and `schema` because the Entity Graph CLI
 * (`@bobsled-inc/entity-graph`) wires these into codegen. Model Spec commands populate them
 * from `resolveIntegration` (see `src/integrations.ts`); Entity Graph callers continue
 * to supply them via CLI flags until the follow-up migration PR.
 */

import { findConfigurationEntry, type ProjectIndex } from '@bobsled-inc/project-index';
import YAML from 'yaml';
import { z } from 'zod';

import { SUPPORTED_DIALECTS } from './compiler/dialect.js';
import { MODEL_SPEC_ERROR_CODES, modelSpecHint, didYouMean } from './compiler/error-hints.js';
import { CommandError } from './errors.js';

import type { SupportedDialect } from './compiler/dialect.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Accepted top-level keys in model-spec.yml. Kept as a named constant so the
 * UNKNOWN_MODEL_SPEC_CONFIG_KEY hint can list them and fuzzy-suggest the closest
 * match when an author typos one.
 *
 * Notably absent: `connection:`, `integration:`, `defaults:` — those have
 * never been valid model-spec.yml keys. Warehouse connection/auth lives in
 * `integrations/<handle>.yml`; project-wide defaults are out of scope.
 */
export const ACCEPTED_MODEL_SPEC_CONFIG_KEYS = [
  'type',
  'sources_dir',
  'models_dir',
  'seeds_dir',
  'entity_graph_dir',
  'mdm_dir',
  'integrations_dir',
  'targets_dir',
  'metrics_dir',
  'relationships_dir',
  'vqs_dir',
  'checkpoint_store',
] as const;

export const CheckpointStoreConfigSchema = z
  .object({
    integration: z.string().trim().min(1).max(1024),
    schema: z.string().trim().min(1).max(1024),
    database: z.string().trim().min(1).max(1024).optional(),
    lease_seconds: z.number().int().min(10).max(600).optional(),
    retention_days: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type CheckpointStoreConfig = z.infer<typeof CheckpointStoreConfigSchema>;

export const ProjectConfigSchema = z
  .object({
    type: z.literal('model_spec_config').optional(),
    sources_dir: z.string().optional(),
    models_dir: z.string().optional(),
    seeds_dir: z.string().optional(),
    entity_graph_dir: z.string().optional(),
    mdm_dir: z.string().optional(),
    integrations_dir: z.string().optional(),
    targets_dir: z.string().optional(),
    metrics_dir: z.string().optional(),
    relationships_dir: z.string().optional(),
    vqs_dir: z.string().optional(),
    checkpoint_store: CheckpointStoreConfigSchema.optional(),
  })
  .strict()
  .transform(({ entity_graph_dir, mdm_dir, ...rest }) => ({
    ...rest,
    entity_graph_dir: entity_graph_dir ?? mdm_dir,
  }));

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONFIG_FILE_NAME = 'model-spec.yml';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadProjectConfigOptions {
  /** Prebuilt project index; `cwd` is scanned when omitted. */
  index?: ProjectIndex;
}

/**
 * Find the project's Model Spec configuration — the file declaring
 * `type: model_spec_config`, or an untyped root `model-spec.yml` — and parse it. Returns a
 * null config when the project has none. Throws on invalid config or removed
 * fields. Problems in other project files are left to the project loaders.
 */
export function loadProjectConfig(
  cwd: string,
  options: LoadProjectConfigOptions = {}
): {
  config: ProjectConfig | null;
} {
  const entry = findConfigurationEntry(cwd, 'model_spec_config', options.index);
  return { config: entry ? parseProjectConfig(entry.content, entry.path) : null };
}

/** Parse Model Spec configuration content; `filePath` only labels error messages. */
export function parseProjectConfig(
  content: string,
  filePath: string = CONFIG_FILE_NAME
): ProjectConfig | null {
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (err) {
    throw new CommandError(
      `Invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2
    );
  }
  if (raw === null || raw === undefined) {
    return null;
  }

  // Hard-fail when removed top-level keys are present.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const rawRecord = raw as Record<string, unknown>;
    const removedPresent = (['dialect', 'schema'] as const).filter((k) => k in rawRecord);
    if (removedPresent.length > 0) {
      throw new CommandError(
        `${filePath} contains removed fields: ${removedPresent.map((k) => `"${k}"`).join(', ')}. Move these into integrations/<handle>.yml. Run \`bobsled model init\` or see the \`bobsled-model-spec\` skill.`,
        2
      );
    }
  }

  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((issue) => {
        // Replace Zod's opaque "Unrecognized key(s)" with a fix-suggesting hint
        // that lists accepted keys and offers a Levenshtein suggestion.
        if (issue.code === z.ZodIssueCode.unrecognized_keys) {
          const unknownKeys = issue.keys ?? [];
          const hints = unknownKeys.map((key) => {
            const suggestion = didYouMean(key, ACCEPTED_MODEL_SPEC_CONFIG_KEYS, 3);
            const head = suggestion
              ? `unknown key "${key}" — did you mean "${suggestion}"?`
              : `unknown key "${key}".`;
            return (
              `${head} Accepted keys: ${ACCEPTED_MODEL_SPEC_CONFIG_KEYS.join(', ')}. ` +
              `(Note: model-spec.yml holds directory overrides and checkpoint_store — connection:/integration:/defaults: are NOT model-spec.yml keys; those live in integrations/<handle>.yml.)`
            );
          });
          return hints.join(' ');
        }
        const pathLabel = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${pathLabel}${issue.message}`;
      })
      .join('; ');
    const hasUnknownKey = parsed.error.issues.some(
      (i) => i.code === z.ZodIssueCode.unrecognized_keys
    );
    const prefix = hasUnknownKey
      ? modelSpecHint(MODEL_SPEC_ERROR_CODES.UNKNOWN_MODEL_SPEC_CONFIG_KEY, '')
      : '';
    throw new CommandError(`Invalid ${filePath}: ${prefix}${messages}`, 2);
  }

  return parsed.data;
}

/**
 * Resolved configuration fed to commands. `dialect` and `schema` carry
 * defaults so Entity Graph callers (which still pass them via CLI flags) keep working;
 * Model Spec commands overwrite both from the active integration.
 */
export interface ResolvedProjectConfig {
  dialect: SupportedDialect;
  schema: string;
  sourcesDir: string;
  modelsDir: string;
  seedsDir: string;
  entityGraphDir: string;
  mdmDir: string;
  integrationsDir: string;
  targetsDir: string;
  metricsDir: string;
  relationshipsDir: string;
  vqsDir: string;
  checkpointStore?: CheckpointStoreConfig;
}

export const DEFAULT_RESOLVED_DIALECT: SupportedDialect = 'snowflake';
export const DEFAULT_RESOLVED_SCHEMA = 'PUBLIC';

/**
 * Resolve effective configuration from (optional) CLI flags plus project
 * config. Priority: CLI flags > config file > hardcoded defaults.
 *
 * Kept signature-compatible with existing Entity Graph callers by accepting
 * `dialect` / `schema` as CLI flags. Model Spec command handlers no longer expose
 * those flags, so they will fall back to the defaults unless overridden by
 * `resolveIntegration`.
 */
export function resolveConfig(
  cliFlags: {
    dialect?: SupportedDialect;
    schema?: string;
    sourcesDir?: string;
    modelsDir?: string;
    seedsDir?: string;
    entityGraphDir?: string;
    mdmDir?: string;
    integrationsDir?: string;
    targetsDir?: string;
    metricsDir?: string;
    relationshipsDir?: string;
    vqsDir?: string;
  },
  projectConfig: ProjectConfig | null
): ResolvedProjectConfig {
  const entityGraphDir =
    cliFlags.entityGraphDir ?? cliFlags.mdmDir ?? projectConfig?.entity_graph_dir ?? 'entity-graph';

  return {
    dialect: cliFlags.dialect ?? DEFAULT_RESOLVED_DIALECT,
    schema: cliFlags.schema ?? DEFAULT_RESOLVED_SCHEMA,
    sourcesDir: cliFlags.sourcesDir ?? projectConfig?.sources_dir ?? 'sources',
    modelsDir: cliFlags.modelsDir ?? projectConfig?.models_dir ?? 'models',
    seedsDir: cliFlags.seedsDir ?? projectConfig?.seeds_dir ?? 'seeds',
    entityGraphDir,
    mdmDir: entityGraphDir,
    integrationsDir: cliFlags.integrationsDir ?? projectConfig?.integrations_dir ?? 'integrations',
    targetsDir: cliFlags.targetsDir ?? projectConfig?.targets_dir ?? 'targets',
    metricsDir: cliFlags.metricsDir ?? projectConfig?.metrics_dir ?? 'metrics',
    relationshipsDir:
      cliFlags.relationshipsDir ?? projectConfig?.relationships_dir ?? 'relationships',
    vqsDir: cliFlags.vqsDir ?? projectConfig?.vqs_dir ?? 'vqs',
    ...(projectConfig?.checkpoint_store ? { checkpointStore: projectConfig.checkpoint_store } : {}),
  };
}

// Re-export for compatibility with callers that used SUPPORTED_DIALECTS from config.
export { SUPPORTED_DIALECTS };
