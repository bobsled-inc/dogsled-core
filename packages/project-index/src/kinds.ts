import { LEGACY_BLUEPRINT_KEY_ALIASES } from '@bobsled-inc/protocol';

/**
 * Declared file types a Dogsled project can contain.
 *
 * A YAML file declares its type with a top-level `type` field and a Markdown
 * file declares it in YAML front matter. The index maps each declared type to
 * a kind; the kind equals the declared type except for `type: source`, which
 * names either a Model Spec model source or an API integration (see
 * `classifySourceDocument`), and the retired model literals that the model
 * schema rejects with a migration hint.
 */

export const PROJECT_FILE_KINDS = [
  'pipeline_config',
  'model_spec_config',
  'extractor_config',
  'extract-intents',
  'integration',
  'target',
  'resource',
  'action',
  'sync',
  'source',
  'model',
  'ossie',
  'interchange',
  'seed',
  'metric',
  'relationship',
  'entity_relationship',
  'vq',
  'resolution',
  'relationship_ontology',
  'ontology',
  'ontology_mapping',
  'mention_extraction',
  'relationship_extraction',
  'agent_task_profile',
  'survivorship',
  'truthset',
  'object',
  'policy',
  'agent',
  'data_product',
  'skill',
  'guide',
] as const;

export type ProjectFileKind = (typeof PROJECT_FILE_KINDS)[number];

/**
 * Kinds a project may contain at most once. A second file of one of these
 * kinds is reported as a duplicate project-wide configuration.
 */
const SINGLETON_KINDS = [
  'model_spec_config',
  'extractor_config',
  'extract-intents',
] as const satisfies readonly ProjectFileKind[];

export type SingletonProjectFileKind = (typeof SINGLETON_KINDS)[number];

export const SINGLETON_PROJECT_FILE_KINDS: ReadonlySet<ProjectFileKind> = new Set(SINGLETON_KINDS);

/** Kinds Dogsled recognizes but leaves to the host application to load. */
export const HOST_PROJECT_FILE_KINDS: ReadonlySet<ProjectFileKind> = new Set([
  'agent',
  'data_product',
]);

const YAML_TYPE_KINDS: ReadonlyMap<string, ProjectFileKind> = new Map(
  PROJECT_FILE_KINDS.filter((kind) => kind !== 'skill' && kind !== 'guide' && kind !== 'ossie').map(
    (kind) => [kind, kind]
  )
);

/**
 * Pre-`type: model` literals. They route to the model kind so the model schema
 * can reject them with its migration hint instead of a generic unknown type.
 */
const RETIRED_MODEL_TYPES: ReadonlySet<string> = new Set([
  'transform',
  'view',
  'table',
  'incremental',
]);

const MARKDOWN_TYPE_KINDS: ReadonlyMap<string, ProjectFileKind> = new Map([
  ['skill', 'skill'],
  ['guide', 'guide'],
]);

export const YAML_PROJECT_FILE_TYPES: readonly string[] = [...YAML_TYPE_KINDS.keys()];

export const MARKDOWN_PROJECT_FILE_TYPES: readonly string[] = [...MARKDOWN_TYPE_KINDS.keys()];

export type SourceDocumentKind = 'source' | 'integration' | 'ambiguous';

const MODEL_SOURCE_SHAPES: ReadonlySet<string> = new Set(['warehouse_table', 'api_resource']);
const INTEGRATION_SOURCE_SHAPES: ReadonlySet<string> = new Set(['custom_api', 'custom_mcp']);
const INTEGRATION_ONLY_FIELDS = [
  'transports',
  'default_transport',
  'auth_env_vars',
  'dogsled_source_kind',
  'dogsled_connection_ref',
  ...Object.keys(LEGACY_BLUEPRINT_KEY_ALIASES),
] as const;

function specVersionOf(document: Readonly<Record<string, unknown>>): string | undefined {
  const version = document['spec_version'];
  if (typeof version === 'string') return version;
  if (typeof version === 'number' && Number.isFinite(version)) return String(version);
  return undefined;
}

/**
 * Decide whether a `type: source` document is a Model Spec model source or an API
 * integration. `spec_version` is authoritative (`'0.2'` model source, `'2'`
 * integration); when it is missing or unfamiliar, the fields that only one
 * shape uses decide.
 */
export function classifySourceDocument(
  document: Readonly<Record<string, unknown>>
): SourceDocumentKind {
  const version = specVersionOf(document);
  if (version === '0.2') return 'source';
  if (version === '2') return 'integration';

  const shape = document['source_type'];
  if (typeof shape === 'string' && MODEL_SOURCE_SHAPES.has(shape)) return 'source';
  if (typeof shape === 'string' && INTEGRATION_SOURCE_SHAPES.has(shape)) return 'integration';
  if (INTEGRATION_ONLY_FIELDS.some((field) => Object.hasOwn(document, field))) {
    return 'integration';
  }
  const schema = document['schema'];
  if (
    typeof schema === 'object' &&
    schema !== null &&
    !Array.isArray(schema) &&
    Object.hasOwn(schema, 'columns')
  ) {
    return 'source';
  }
  return 'ambiguous';
}

export type YamlTypeResolution =
  | { readonly status: 'kind'; readonly kind: ProjectFileKind }
  | { readonly status: 'ambiguous_source' }
  | { readonly status: 'unknown' };

export function resolveYamlType(
  declaredType: string,
  document: Readonly<Record<string, unknown>>
): YamlTypeResolution {
  if (declaredType === 'source') {
    const kind = classifySourceDocument(document);
    return kind === 'ambiguous' ? { status: 'ambiguous_source' } : { status: 'kind', kind };
  }
  if (RETIRED_MODEL_TYPES.has(declaredType)) return { status: 'kind', kind: 'model' };
  const kind = YAML_TYPE_KINDS.get(declaredType);
  return kind ? { status: 'kind', kind } : { status: 'unknown' };
}

export function resolveMarkdownType(declaredType: string): ProjectFileKind | undefined {
  return MARKDOWN_TYPE_KINDS.get(declaredType);
}

/** True for a declared type whose file Dogsled itself loads (not a host-owned kind). */
export function isDogsledFileType(declaredType: string): boolean {
  const kind = RETIRED_MODEL_TYPES.has(declaredType)
    ? 'model'
    : (YAML_TYPE_KINDS.get(declaredType) ?? MARKDOWN_TYPE_KINDS.get(declaredType));
  return kind !== undefined && !HOST_PROJECT_FILE_KINDS.has(kind);
}
