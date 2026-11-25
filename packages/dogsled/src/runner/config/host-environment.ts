import {
  AuthEnvVarsSchema,
  collectEnvironmentReferences,
  CommandError,
  declaredNamesProblem,
  withDeclaredAuthEnvVars,
  withDeclaredModelApiKey,
} from '@bobsled-inc/protocol';
import { entriesOfKind, type ProjectIndex } from '@bobsled-inc/project-index';
import { parse as parseYaml } from 'yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate host-declared names before they reach any configuration. The names
 * are declarations only: validation never reads their values from any
 * environment.
 */
export function parseHostDeclaredEnvNames(names: readonly string[] | undefined): string[] {
  if (names === undefined) return [];
  const parsed = AuthEnvVarsSchema.safeParse(names);
  if (!parsed.success) {
    throw new CommandError(declaredNamesProblem('declaredEnvNames', parsed.error), 2);
  }
  return [...new Set(parsed.data ?? [])];
}

function declareRecordEntries(
  entries: unknown,
  names: readonly string[],
  declare: (entry: Record<string, unknown>) => unknown
): unknown {
  if (!isRecord(entries)) return entries;
  return Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [name, isRecord(entry) ? declare(entry) : entry])
  );
}

/**
 * Union host-declared names into the configuration blocks whose schemas
 * enforce declarations: pipeline embeddings and `platform.models` profiles.
 * With `hostManagedModelAuth`, each `platform.models` profile also declares its
 * own `api_key` name; pipeline embeddings are unaffected. Placeholders and the
 * authored document are left unchanged.
 */
export function declareHostConfigEnvironment(
  config: Record<string, unknown>,
  names: readonly string[],
  hostManagedModelAuth = false
): Record<string, unknown> {
  if (!names.length && !hostManagedModelAuth) return config;
  const declared = { ...config };
  if (isRecord(config['pipelines'])) {
    declared['pipelines'] = declareRecordEntries(config['pipelines'], names, (pipeline) =>
      pipeline['embed']
        ? { ...pipeline, embed: withDeclaredAuthEnvVars(pipeline['embed'], names) }
        : pipeline
    );
  }
  const platform = config['platform'];
  if (isRecord(platform) && isRecord(platform['models'])) {
    declared['platform'] = {
      ...platform,
      models: declareRecordEntries(platform['models'], names, (model) => {
        const declared = withDeclaredAuthEnvVars(model, names);
        return hostManagedModelAuth ? withDeclaredModelApiKey(declared) : declared;
      }),
    };
  }
  return declared;
}

/**
 * Declare each pipeline embedding's and `platform.models` profile's own
 * `api_key` name, so parsing checks structure but not credential
 * declarations. Only for reading Project names; never resolve or run the
 * result. Placeholders and the authored document are left unchanged.
 */
export function declareOwnModelApiKeys(config: Record<string, unknown>): Record<string, unknown> {
  const declared = { ...config };
  if (isRecord(config['pipelines'])) {
    declared['pipelines'] = declareRecordEntries(config['pipelines'], [], (pipeline) =>
      pipeline['embed']
        ? { ...pipeline, embed: withDeclaredModelApiKey(pipeline['embed']) }
        : pipeline
    );
  }
  const platform = config['platform'];
  if (isRecord(platform) && isRecord(platform['models'])) {
    declared['platform'] = {
      ...platform,
      models: declareRecordEntries(platform['models'], [], withDeclaredModelApiKey),
    };
  }
  return declared;
}

const DECLARED_DOCUMENT_KINDS = [
  ['integration', 'Integration'],
  ['action', 'Action'],
] as const;

/**
 * Advisory diagnostics for integrations and actions whose credential
 * references are not declared. These are enforced when a request is made, so
 * validation reports them as warnings rather than errors.
 */
export function undeclaredCredentialWarnings(
  index: ProjectIndex,
  hostDeclaredNames: readonly string[]
): string[] {
  const warnings: string[] = [];
  for (const [kind, label] of DECLARED_DOCUMENT_KINDS) {
    for (const entry of entriesOfKind(index, kind)) {
      let document: unknown;
      try {
        document = parseYaml(entry.content);
      } catch {
        continue;
      }
      if (!isRecord(document)) continue;
      const declared = AuthEnvVarsSchema.safeParse(document['auth_env_vars']);
      const allowed = new Set([
        ...(declared.success ? (declared.data ?? []) : []),
        ...hostDeclaredNames,
      ]);
      const missing = [...collectEnvironmentReferences(document)].filter(
        (name) => !allowed.has(name)
      );
      if (!missing.length) continue;
      const name = typeof document['name'] === 'string' ? ` "${document['name']}"` : '';
      warnings.push(
        `${entry.path}: ${label}${name} references undeclared environment variable${
          missing.length === 1 ? '' : 's'
        } ${missing.sort().join(', ')}. Add ${
          missing.length === 1 ? 'it' : 'them'
        } to auth_env_vars; requests that use an undeclared name are rejected.`
      );
    }
  }
  return warnings;
}
