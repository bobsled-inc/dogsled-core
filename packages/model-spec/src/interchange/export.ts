import { exportOntologyScopes } from '../ontology/export-scopes.js';
import { exportOntologyDocuments } from '../ontology/conversion.js';
import { z } from 'zod';

import { AgenticModelSpecSchema, getModelOutputColumns } from '../agentic/model.js';
import { discardedKeyPaths } from '../compiler/discarded-keys.js';
import { SourceSpecSchema, TransformSpecSchema } from '../compiler/schemas.js';
import { MetricSpecSchema } from '../entities/metric.js';
import { RelationshipSpecSchema, RelationshipTypeSchema } from '../entities/relationship.js';
import { datasetPrimaryKey, relationshipKeyWarnings } from '../entities/relationship-keys.js';
import {
  aiContextSynonyms,
  mergeSynonyms,
  withAiContextSynonyms,
} from '../entities/semantic-metadata.js';
import { readOssieProfile } from '../ossie/profiles.js';
import { logicalTypeForSqlType } from '../ossie/types.js';
import { InterchangeSchema, type OssieCustomExtension } from './storage.js';
import {
  assertBounded,
  blocksStrictConversion,
  diagnostic,
  errorMessage,
  file,
  identity,
  record,
  OSSIE_VENDOR,
  type ConversionObjectReference,
  type ConversionResult,
} from './common.js';
import { exportVerifiedQueries, VerifiedQueryFailure } from './verified-queries.js';

export type OssieVersion = '0.1.1' | '0.2.0.dev0';

export type OssieExportSelection =
  | { all: true }
  | {
      all?: false;
      selectors: Array<
        { kind: 'model'; name: string } | { kind: 'source'; connection: string; name: string }
      >;
    };

export interface ExportOssieDocumentRequest {
  project: {
    sources: readonly unknown[];
    models: readonly unknown[];
    metrics: readonly unknown[];
    relationships: readonly unknown[];
    verifiedQueries?: readonly unknown[];
    /** Host-resolved addresses. Models use name; sources use connection.name. */
    addresses: Record<string, string>;
  };
  semanticModelName: string;
  selection: OssieExportSelection;
  ossieVersion?: OssieVersion;
  strict?: boolean;
}

export interface NativeInterchangeInput {
  path: string;
  document: unknown;
}

export interface ExportOssieOptions {
  addresses?: Record<string, string>;
  name?: string;
  ossieVersion?: OssieVersion;
  strict?: boolean;
}

interface NativeDataset {
  kind: 'source' | 'model';
  name: string;
  reference: string;
  path: string;
  document: Record<string, unknown>;
  outputColumns: readonly unknown[];
  catalogOnlyReason?: 'agentic' | 'flatten_json' | 'derived_columns';
}

class ExportFailure extends Error {
  constructor(
    readonly code: string,
    readonly diagnosticPath: string,
    message: string,
    readonly objectReference: ConversionObjectReference,
    readonly remedy: string
  ) {
    super(message);
  }
}

/**
 * A whole-Project export is bigger than any one input, so the finished document gets its own,
 * larger limit. Callers that store the result should allow at least this much.
 */
export const OSSIE_EXPORT_MAX_BYTES = 10_000_000;
export const OSSIE_EXPORT_MAX_NODES = 1_000_000;
const unsupportedBuildKeys = [
  'include_all_columns',
  'exclude_columns',
  'pivot',
  'unpivot',
  'hierarchy',
  'recurse',
] as const;

const vendors011 = new Set(['COMMON', 'SNOWFLAKE', 'SALESFORCE', 'DBT', 'DATABRICKS', 'GOODDATA']);

const dialects011 = new Set(['ANSI_SQL', 'SNOWFLAKE', 'MDX', 'TABLEAU', 'DATABRICKS', 'MAQL']);

function objectReference(dataset?: string, field?: string): ConversionObjectReference {
  return { documentPath: 'project', ...(dataset ? { dataset } : {}), ...(field ? { field } : {}) };
}

function fail(
  code: string,
  path: string,
  message: string,
  remedy: string,
  reference = objectReference()
): never {
  throw new ExportFailure(code, path, message, reference, remedy);
}

function warn(
  result: ConversionResult,
  code: string,
  path: string,
  message: string,
  remedy: string,
  reference = objectReference()
): void {
  result.diagnostics.push(diagnostic(code, path, message, 'warning', reference, remedy));
}

/** Ossie keeps synonyms in ai_context, so native synonyms are merged into it. */
function ossieAiContext(aiContext: unknown, synonyms: unknown): unknown {
  return withAiContextSynonyms(aiContext, mergeSynonyms(synonyms, aiContextSynonyms(aiContext)));
}

function aiContextProperty(aiContext: unknown): { ai_context?: unknown } {
  return aiContext === undefined ? {} : { ai_context: aiContext };
}

/**
 * Native schemas strip keys they do not use, such as a type on a union branch column, and
 * loadProject only warns about them. Export leaves them out too and warns once per dataset,
 * folding array positions so one repeated key is listed once.
 */
function ignoredProperties(raw: Record<string, unknown>, parsed: unknown): string[] {
  return [
    ...new Set(discardedKeyPaths(raw, parsed).map((path) => path.replace(/\[\d+\]/g, '[*]'))),
  ].sort();
}

/** Names an input document for errors raised before it is parsed. */
function inputLabel(collection: string, value: unknown, index: number): string {
  const name =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.getOwnPropertyDescriptor(value, 'name')?.value
      : undefined;
  return `project#${collection}.${typeof name === 'string' && name ? name : `[${index}]`}`;
}

function parseDataset(
  kind: 'source' | 'model',
  value: unknown,
  index: number
): NativeDataset & { ignoredProperties: string[] } {
  assertBounded(value, inputLabel(kind === 'source' ? 'sources' : 'models', value, index));
  const raw = record(value);
  let parsed: unknown;
  let outputColumns: readonly unknown[];
  if (kind === 'source') {
    const source = SourceSpecSchema.parse(raw);
    parsed = source;
    outputColumns = source.schema.columns;
  } else if (raw['model_kind'] === 'agentic') {
    const model = AgenticModelSpecSchema.parse(raw);
    parsed = model;
    outputColumns = getModelOutputColumns(model);
  } else {
    const model = TransformSpecSchema.parse(raw);
    parsed = model;
    outputColumns = [...getModelOutputColumns(model), ...(model.derived_columns ?? [])];
  }
  const document = record(parsed);
  const name = String(document['name']);
  const reference =
    kind === 'source' ? `${String(document['connection'])}.${name}` : String(document['name']);
  const catalogOnlyReason =
    kind === 'model' && document['model_kind'] === 'agentic'
      ? 'agentic'
      : kind === 'model' && document['flatten_json'] !== undefined
        ? 'flatten_json'
        : kind === 'model' && document['derived_columns'] !== undefined
          ? 'derived_columns'
          : undefined;
  return {
    kind,
    name,
    reference,
    path: `project#datasets.${name}`,
    document,
    outputColumns,
    ignoredProperties: ignoredProperties(raw, parsed),
    ...(catalogOnlyReason ? { catalogOnlyReason } : {}),
  };
}

function isSelectedDatasetInput(
  kind: 'source' | 'model',
  value: unknown,
  selection: OssieExportSelection
): boolean {
  if ('all' in selection && selection.all === true) return true;
  const raw = record(value);
  return selection.selectors.some(
    (selector) =>
      selector.kind === kind &&
      selector.name === raw['name'] &&
      (kind === 'model' ||
        (selector.kind === 'source' && selector.connection === raw['connection']))
  );
}

function parseProject(
  request: ExportOssieDocumentRequest,
  result: ConversionResult
): {
  datasets: NativeDataset[];
  metrics: Record<string, unknown>[];
  relationships: Record<string, unknown>[];
} {
  const datasets = [
    ...request.project.sources.flatMap((value, index) =>
      isSelectedDatasetInput('source', value, request.selection)
        ? [parseDataset('source', value, index)]
        : []
    ),
    ...request.project.models.flatMap((value, index) =>
      isSelectedDatasetInput('model', value, request.selection)
        ? [parseDataset('model', value, index)]
        : []
    ),
  ].sort((left, right) => left.reference.localeCompare(right.reference));
  for (const { ignoredProperties: paths, name, path } of datasets) {
    if (!paths.length) continue;
    warn(
      result,
      'native_property_ignored',
      path,
      `Dogsled ignores ${paths.join(', ')} on ${name}, so the export leaves ${paths.length === 1 ? 'it' : 'them'} out.`,
      'Remove the property from the Blueprint, or move it to a supported property.',
      objectReference(name)
    );
  }
  const references = new Set<string>();
  for (const dataset of datasets) {
    if (references.has(dataset.reference)) {
      fail(
        'duplicate_identity',
        dataset.path,
        `More than one native dataset uses ${dataset.reference}.`,
        'Give each source or model a unique native identity.',
        objectReference(dataset.name)
      );
    }
    references.add(dataset.reference);
  }
  const metrics = request.project.metrics
    .map((value, index) => {
      assertBounded(value, inputLabel('metrics', value, index));
      return record(MetricSpecSchema.parse(value));
    })
    .sort((left, right) => String(left['name']).localeCompare(String(right['name'])));
  const relationships = request.project.relationships
    .map((value, index) => {
      assertBounded(value, inputLabel('relationships', value, index));
      return record(RelationshipSpecSchema.parse(value));
    })
    .sort((left, right) => String(left['name']).localeCompare(String(right['name'])));
  for (const [kind, values] of [
    ['metric', metrics],
    ['relationship', relationships],
  ] as const) {
    const names = new Set<string>();
    for (const value of values) {
      const name = String(value['name']);
      if (names.has(name)) {
        fail(
          'duplicate_identity',
          `project#${kind}s.${name}`,
          `More than one native ${kind} uses ${name}.`,
          `Give each ${kind} a unique name.`
        );
      }
      names.add(name);
    }
  }
  return { datasets, metrics, relationships };
}

function selectedDatasets(
  datasets: readonly NativeDataset[],
  selection: OssieExportSelection
): NativeDataset[] {
  if ('all' in selection && selection.all === true) return [...datasets];
  const selectors = 'selectors' in selection ? selection.selectors : [];
  if (!selectors.length) {
    fail(
      'native_incomplete',
      'selection',
      'Select at least one source or derived model.',
      'Supply exact selectors or select all supported datasets.'
    );
  }
  const selected = new Map<string, NativeDataset>();
  for (const selector of selectors) {
    const reference =
      selector.kind === 'source' ? `${selector.connection}.${selector.name}` : selector.name;
    const match = datasets.find(
      (dataset) => dataset.kind === selector.kind && dataset.reference === reference
    );
    if (!match) {
      fail(
        'native_incomplete',
        'selection',
        `Unknown ${selector.kind} selector ${reference}.`,
        'Use a source connection and name, or an exact derived model name.'
      );
    }
    selected.set(match.reference, match);
  }
  return [...selected.values()].sort((left, right) =>
    left.reference.localeCompare(right.reference)
  );
}

function ownerExtensions(value: Record<string, unknown>): OssieCustomExtension[] {
  const interchange = value['interchange'];
  if (interchange === undefined) return [];
  return z
    .object({ ossie: z.object({ custom_extensions: z.array(z.any()) }) })
    .passthrough()
    .parse(interchange)
    .ossie.custom_extensions.map((entry) =>
      z.object({ vendor_name: z.string(), data: z.string() }).strict().parse(entry)
    );
}

function datasetExtensionOwnership(dataset: NativeDataset): {
  dataset: OssieCustomExtension[];
  fields: Map<string, OssieCustomExtension[]>;
} {
  const interchange = dataset.document['interchange'];
  if (interchange === undefined) return { dataset: [], fields: new Map() };
  const stored = InterchangeSchema.parse(interchange).ossie;
  const fields = new Map<string, OssieCustomExtension[]>();

  for (const field of stored.fields ?? []) {
    if (fields.has(field.field)) {
      fail(
        'duplicate_identity',
        `${dataset.path}.interchange.fields`,
        `More than one Ossie metadata record owns field ${field.field}.`,
        'Keep one metadata owner for each field.',
        objectReference(dataset.name, field.field)
      );
    }
    fields.set(field.field, field.custom_extensions);
  }
  return { dataset: stored.custom_extensions ?? [], fields };
}

function profileExtensions(
  values: readonly OssieCustomExtension[],
  version: OssieVersion,
  result: ConversionResult,
  path: string,
  reference: ConversionObjectReference
): OssieCustomExtension[] {
  const foreign = values.filter((entry) => entry.vendor_name !== OSSIE_VENDOR);
  if (version === '0.2.0.dev0') return foreign;
  const kept = foreign.filter((entry) => vendors011.has(entry.vendor_name));
  for (const entry of foreign) {
    if (vendors011.has(entry.vendor_name)) continue;
    warn(
      result,
      'native_metadata_not_supported_by_profile',
      path,
      `Ossie 0.1.1 does not allow the ${entry.vendor_name} extension.`,
      'Use Ossie 0.2.0.dev0 to preserve this extension.',
      reference
    );
  }
  return kept;
}

function dogsledExtension(data: Record<string, unknown>): OssieCustomExtension {
  assertBounded(data);
  return { vendor_name: OSSIE_VENDOR, data: JSON.stringify(data) };
}

function outputExpression(
  value: unknown,
  fallback: string,
  version: OssieVersion,
  result: ConversionResult,
  path: string,
  reference: ConversionObjectReference
): Record<string, unknown> {
  const parsed = z
    .object({
      dialects: z.array(
        z.object({ dialect: z.string().min(1), expression: z.string().min(1) }).strict()
      ),
    })
    .strict()
    .optional()
    .parse(value);
  const dialects = parsed?.dialects ?? [{ dialect: 'ANSI_SQL', expression: fallback }];
  if (version === '0.2.0.dev0') return { dialects };
  const supported = dialects.filter((entry) => dialects011.has(entry.dialect));
  if (supported.length !== dialects.length) {
    warn(
      result,
      'native_metadata_not_supported_by_profile',
      path,
      'Ossie 0.1.1 does not support every semantic expression dialect.',
      'Use Ossie 0.2.0.dev0 to preserve all expression dialects.',
      reference
    );
  }
  return {
    dialects: supported.length ? supported : [{ dialect: 'ANSI_SQL', expression: fallback }],
  };
}

function outputFields(
  dataset: NativeDataset,
  version: OssieVersion,
  result: ConversionResult
): Record<string, unknown>[] {
  const columns = dataset.outputColumns;
  if (!Array.isArray(columns) || !columns.length) {
    fail(
      'native_incomplete',
      `${dataset.path}.fields`,
      'Explicit native fields are required for Ossie export.',
      'Declare the final output fields before exporting.',
      objectReference(dataset.name)
    );
  }
  const ownership = datasetExtensionOwnership(dataset);
  const names = new Set(columns.map((column) => String(record(column)['name'])));
  for (const field of ownership.fields.keys()) {
    if (!names.has(field)) {
      fail(
        'native_incomplete',
        `${dataset.path}.interchange.fields.${field}`,
        `Ossie metadata still owns missing field ${field}.`,
        'Rebind or remove the field metadata after reviewing the foreign payload.',
        objectReference(dataset.name, field)
      );
    }
  }
  return columns.map((value) => {
    const column = record(value);
    const name = String(column['name']);
    const path = `${dataset.path}.fields.${name}`;
    const reference = objectReference(dataset.name, name);
    const {
      name: _name,
      description,
      type,
      expr,
      primary_key: _primaryKey,
      nullable,
      semantic_expression: semanticExpression,
      is_time: isTime,
      ai_context: nativeAiContext,
      synonyms,
      ...nativeMetadata
    } = column;
    const aiContext = ossieAiContext(nativeAiContext, synonyms);
    const payload: Record<string, unknown> = {
      ...(typeof type === 'string' ? { sql_type: type } : {}),
      ...(dataset.kind === 'model' && !dataset.catalogOnlyReason && typeof expr === 'string'
        ? { build_expression: expr }
        : {}),
      ...(nullable === false ? { not_null: true } : {}),
      ...nativeMetadata,
    };
    const customExtensions = profileExtensions(
      ownership.fields.get(name) ?? [],
      version,
      result,
      `${path}.custom_extensions`,
      reference
    );
    if (version === '0.2.0.dev0' && Object.keys(payload).length) {
      customExtensions.push(dogsledExtension(payload));
    } else if (version === '0.1.1' && Object.keys(payload).length) {
      warn(
        result,
        'native_metadata_not_supported_by_profile',
        path,
        `Ossie 0.1.1 cannot preserve native field data for ${dataset.name}.${name}.`,
        'Use Ossie 0.2.0.dev0 for a Dogsled round trip.',
        reference
      );
    }
    return {
      name,
      expression: outputExpression(
        semanticExpression,
        name,
        version,
        result,
        `${path}.expression`,
        reference
      ),
      ...(description !== undefined ? { description } : {}),
      ...(version === '0.2.0.dev0' && typeof type === 'string'
        ? { datatype: logicalTypeForSqlType(type) }
        : {}),
      ...(isTime !== undefined ? { dimension: { is_time: isTime } } : {}),
      ...(aiContext !== undefined ? { ai_context: aiContext } : {}),
      ...(customExtensions.length ? { custom_extensions: customExtensions } : {}),
    };
  });
}

function datasetAddress(dataset: NativeDataset, addresses: Record<string, string>): string {
  const resolved = addresses[dataset.reference];
  if (resolved) return resolved;
  if (dataset.kind === 'source') {
    if (dataset.document['source_type'] === 'warehouse_table') {
      return String(dataset.document['table']);
    }
    return `dogsled://sources/${String(dataset.document['connection'])}/${dataset.name}`;
  }
  if (record(dataset.document['materialization'])['type'] === 'ephemeral') {
    return `dogsled://models/${dataset.name}`;
  }
  return fail(
    'native_incomplete',
    `${dataset.path}.source`,
    `No current output address was supplied for ${dataset.reference}.`,
    'Resolve the model output address through the Dogsled project host.',
    objectReference(dataset.name)
  );
}

function outputDataset(
  dataset: NativeDataset,
  request: ExportOssieDocumentRequest,
  version: OssieVersion,
  result: ConversionResult
): Record<string, unknown> {
  const ownership = datasetExtensionOwnership(dataset);
  const customExtensions = profileExtensions(
    ownership.dataset,
    version,
    result,
    `${dataset.path}.custom_extensions`,
    objectReference(dataset.name)
  );
  const fields = outputFields(dataset, version, result);
  const primaryKey = datasetPrimaryKey(dataset.document, dataset.outputColumns);
  if (dataset.kind === 'source') {
    const {
      spec_version: _specVersion,
      type: _type,
      name: _name,
      description: _description,
      ai_context: _aiContext,
      synonyms: _synonyms,
      table: _table,
      schema: _schema,
      interchange: _interchange,
      ...settings
    } = dataset.document;
    if (version === '0.2.0.dev0') {
      customExtensions.push(
        dogsledExtension({ extension_version: '2', kind: 'source', ...settings })
      );
    } else {
      warn(
        result,
        'native_metadata_not_supported_by_profile',
        dataset.path,
        `Ossie 0.1.1 cannot preserve source settings for ${dataset.reference}.`,
        'Use Ossie 0.2.0.dev0 for a Dogsled round trip.',
        objectReference(dataset.name)
      );
    }
  } else {
    if (dataset.catalogOnlyReason) {
      const detail =
        dataset.catalogOnlyReason === 'agentic'
          ? 'its agent plan and execution settings'
          : `its ${dataset.catalogOnlyReason} build and other execution settings`;
      warn(
        result,
        'catalog_only_export',
        dataset.path,
        `Model ${dataset.name} was exported as its finished dataset; ${detail} are not preserved. Reimport treats it as a source.`,
        'Keep the native Dogsled model when executable behavior must be preserved.',
        objectReference(dataset.name)
      );
    } else {
      const {
        spec_version: _specVersion,
        type: _type,
        model_kind: _modelKind,
        name: _name,
        description: _description,
        grain,
        columns: _columns,
        interchange: _interchange,
        ai_context: _aiContext,
        synonyms: _synonyms,
        ...build
      } = dataset.document;
      if (version === '0.2.0.dev0') {
        customExtensions.push(
          dogsledExtension({ extension_version: '2', kind: 'derived', grain, build })
        );
      } else {
        warn(
          result,
          'native_metadata_not_supported_by_profile',
          dataset.path,
          `Ossie 0.1.1 cannot preserve build settings for ${dataset.name}.`,
          'Use Ossie 0.2.0.dev0 for a Dogsled round trip.',
          objectReference(dataset.name)
        );
      }
    }
  }
  return {
    name: dataset.name,
    source: datasetAddress(dataset, request.project.addresses),
    ...(dataset.document['description'] !== undefined
      ? { description: dataset.document['description'] }
      : {}),
    ...aiContextProperty(
      ossieAiContext(dataset.document['ai_context'], dataset.document['synonyms'])
    ),
    ...(primaryKey.length ? { primary_key: primaryKey } : {}),
    fields,
    ...(customExtensions.length ? { custom_extensions: customExtensions } : {}),
  };
}

function datasetReferences(value: Record<string, unknown>): string[] {
  const single = value['model'];
  if (typeof single === 'string') return [single];
  return z.array(z.string()).parse(value['models']);
}

function selectedObject(
  references: readonly string[],
  selected: Set<string>,
  result: ConversionResult,
  path: string,
  kind: 'metric' | 'relationship',
  name: string
): boolean {
  const selectedCount = references.filter((reference) => selected.has(reference)).length;
  if (selectedCount === 0) return false;
  if (selectedCount === references.length) return true;
  warn(
    result,
    'export_object_partially_selected',
    path,
    `${kind} ${name} was omitted because only some referenced datasets were selected.`,
    'Select every referenced dataset to include this object.'
  );
  return false;
}

function referenceNames(
  references: readonly string[],
  byReference: Map<string, NativeDataset>,
  path: string
): string[] {
  return references.map((reference) => {
    const dataset = byReference.get(reference);
    if (!dataset) {
      fail(
        'native_incomplete',
        path,
        `Dataset reference ${reference} does not exist in the native project.`,
        'Correct the native dataset reference before exporting.'
      );
    }
    return dataset.name;
  });
}

function standardMetricExpression(expression: string, datasets: readonly NativeDataset[]): string {
  let output = expression;
  for (const dataset of datasets) {
    if (dataset.kind !== 'source') continue;
    output = output.replaceAll(`{${dataset.reference}.`, `{${dataset.name}.`);
  }
  return output;
}

function outputMetrics(
  metrics: readonly Record<string, unknown>[],
  selected: Set<string>,
  byReference: Map<string, NativeDataset>,
  version: OssieVersion,
  result: ConversionResult
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const metric of metrics) {
    const name = String(metric['name']);
    const path = `project#metrics.${name}`;
    const references = datasetReferences(metric);
    if (!selectedObject(references, selected, result, path, 'metric', name)) continue;
    const datasets = references.map((reference) => byReference.get(reference)!);
    const names = referenceNames(references, byReference, path);
    const expression = String(metric['expression']);
    const customExtensions = profileExtensions(
      ownerExtensions(metric),
      version,
      result,
      `${path}.custom_extensions`,
      objectReference()
    );
    if (version === '0.2.0.dev0') {
      customExtensions.push(
        dogsledExtension({
          extension_version: '2',
          datasets: names,
          expression,
          ...(metric['tags'] !== undefined ? { tags: metric['tags'] } : {}),
        })
      );
    } else {
      warn(
        result,
        'native_metadata_not_supported_by_profile',
        path,
        `Ossie 0.1.1 cannot preserve exact native metric data for ${name}.`,
        'Use Ossie 0.2.0.dev0 for a Dogsled round trip.'
      );
      if (metric['datatype'] !== undefined) {
        warn(
          result,
          'metric_datatype_not_supported_by_profile',
          `${path}.datatype`,
          `Ossie 0.1.1 cannot store the datatype for metric ${name}.`,
          'Use Ossie 0.2.0.dev0 to preserve the metric datatype.'
        );
      }
    }
    const portableExpression = standardMetricExpression(expression, datasets);
    output.push({
      name,
      expression: outputExpression(
        metric['semantic_expression'],
        portableExpression,
        version,
        result,
        `${path}.expression`,
        objectReference()
      ),
      ...(metric['description'] !== undefined ? { description: metric['description'] } : {}),
      ...(version === '0.2.0.dev0' && metric['datatype'] !== undefined
        ? { datatype: metric['datatype'] }
        : {}),
      ...aiContextProperty(ossieAiContext(metric['ai_context'], metric['synonyms'])),
      ...(customExtensions.length ? { custom_extensions: customExtensions } : {}),
    });
  }
  return output;
}

function outputRelationships(
  relationships: readonly Record<string, unknown>[],
  selected: Set<string>,
  byReference: Map<string, NativeDataset>,
  version: OssieVersion,
  result: ConversionResult
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const relationship of relationships) {
    const name = String(relationship['name']);
    const path = `project#relationships.${name}`;
    const leftReference = String(relationship['left_model']);
    const rightReference = String(relationship['right_model']);
    const references = [leftReference, rightReference];
    if (!selectedObject(references, selected, result, path, 'relationship', name)) continue;
    const [leftName, rightName] = referenceNames(references, byReference, path);
    const joinColumns = z
      .array(z.object({ left: z.string(), right: z.string() }))
      .parse(relationship['join_columns']);
    const relationshipType = RelationshipTypeSchema.parse(relationship['relationship_type']);
    const flip = relationshipType === 'one_to_many';
    const keyWarnings = relationshipKeyWarnings(
      {
        name,
        left_model: leftReference,
        right_model: rightReference,
        join_columns: joinColumns,
        relationship_type: relationshipType,
      },
      (reference) => {
        const dataset = byReference.get(reference)!;
        return datasetPrimaryKey(dataset.document, dataset.outputColumns);
      }
    );
    for (const warning of keyWarnings) {
      warn(
        result,
        warning.code,
        `${path}.join_columns`,
        warning.message,
        warning.remedy,
        objectReference(byReference.get(warning.dataset)!.name)
      );
    }
    const customExtensions = profileExtensions(
      ownerExtensions(relationship),
      version,
      result,
      `${path}.custom_extensions`,
      objectReference()
    );
    if (relationshipType === 'one_to_one' || relationshipType === 'many_to_many') {
      warn(
        result,
        'relationship_cardinality_projected',
        path,
        `Standard Ossie projects ${relationshipType} relationship ${name} as many-to-one.`,
        'Use the DOGSLED metadata in Ossie 0.2.0.dev0 to restore exact cardinality.'
      );
    }
    if (version === '0.2.0.dev0') {
      customExtensions.push(
        dogsledExtension({
          extension_version: '2',
          left_side: flip ? 'to' : 'from',
          relationship_type: relationshipType,
          join_type: relationship['join_type'],
          ...(relationship['description'] !== undefined
            ? { description: relationship['description'] }
            : {}),
          ...(relationship['tags'] !== undefined ? { tags: relationship['tags'] } : {}),
        })
      );
    } else {
      warn(
        result,
        'relationship_join_type_not_preserved',
        `${path}.join_type`,
        `Ossie 0.1.1 cannot preserve the native join type for ${name}.`,
        'Use Ossie 0.2.0.dev0 for a Dogsled round trip.'
      );
      if (relationship['description'] !== undefined || relationship['tags'] !== undefined) {
        warn(
          result,
          'native_metadata_not_supported_by_profile',
          path,
          `Ossie 0.1.1 cannot preserve all native relationship data for ${name}.`,
          'Use Ossie 0.2.0.dev0 for a Dogsled round trip.'
        );
      }
    }
    output.push({
      name,
      from: flip ? rightName : leftName,
      to: flip ? leftName : rightName,
      from_columns: joinColumns.map((pair) => (flip ? pair.right : pair.left)),
      to_columns: joinColumns.map((pair) => (flip ? pair.left : pair.right)),
      ...(relationship['ai_context'] !== undefined
        ? { ai_context: relationship['ai_context'] }
        : {}),
      ...(customExtensions.length ? { custom_extensions: customExtensions } : {}),
    });
  }
  return output;
}

function collectReferences(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return found;
  if (!Array.isArray(value) && 'ref' in value && typeof value.ref === 'string') {
    found.add(value.ref);
  }
  for (const child of Object.values(value)) collectReferences(child, found);
  return found;
}

function addDependencyDiagnostics(
  datasets: readonly NativeDataset[],
  selected: Set<string>,
  result: ConversionResult
): void {
  for (const dataset of datasets) {
    if (dataset.kind !== 'model') continue;
    const buildReferences =
      dataset.document['model_kind'] === 'agentic'
        ? dataset.document['sources']
        : {
            source: dataset.document['source'],
            joins: dataset.document['joins'],
            union: dataset.document['union'],
          };
    for (const reference of [...collectReferences(buildReferences)].sort()) {
      if (selected.has(reference)) continue;
      warn(
        result,
        'export_dependency_not_selected',
        `${dataset.path}.build`,
        `Model ${dataset.name} refers to unselected dataset ${reference}.`,
        'Select the dependency to make the Ossie document self-contained.',
        objectReference(dataset.name)
      );
    }
  }
}

/** Convert canonical native Dogsled objects into one validated Ossie YAML document. */
/**
 * Ossie needs every output field listed. These settings make columns that the Blueprint does
 * not list. A whole-Project export leaves such models out with one warning, so the rest of the
 * Project still exports. A model the caller selects by name is refused, since leaving it out
 * would not be what was asked for.
 */
function withoutUnlistedColumns(
  selected: readonly NativeDataset[],
  selection: OssieExportSelection,
  result: ConversionResult
): NativeDataset[] {
  const rejected = selected.flatMap((dataset) => {
    if (dataset.kind !== 'model') return [];
    const keys = unsupportedBuildKeys.filter((key) => key in dataset.document);
    return keys.length ? [{ dataset, keys }] : [];
  });
  const first = rejected[0];
  if (!first) return [...selected];
  const list = rejected
    .map(({ dataset, keys }) => `${dataset.name} (${keys.join(', ')})`)
    .join(', ');
  const one = rejected.length === 1;
  const reason = `${one ? 'Model' : 'Models'} ${list} ${one ? 'makes' : 'make'} columns that the Blueprint does not list, so Ossie export cannot describe ${one ? 'its' : 'their'} fields.`;
  const remedy =
    'List every output column under columns and remove these settings to include them.';
  const path = `${first.dataset.path}.${first.keys[0]}`;
  const reference = objectReference(first.dataset.name);
  const remaining = selected.filter(
    (dataset) => !rejected.some((entry) => entry.dataset === dataset)
  );
  if (!('all' in selection && selection.all === true)) {
    fail('native_incomplete', path, reason, `${remedy} Or select other datasets.`, reference);
  }
  if (!remaining.length) {
    fail(
      'native_incomplete',
      path,
      `${reason} No other datasets are left to export.`,
      remedy,
      reference
    );
  }
  warn(
    result,
    'native_dataset_omitted',
    path,
    `${reason} The export leaves ${one ? 'it' : 'them'} out.`,
    remedy,
    reference
  );
  return remaining;
}

export function exportOssieDocument(request: ExportOssieDocumentRequest): ConversionResult {
  const result: ConversionResult = { ok: false, ready: false, files: [], diagnostics: [] };
  try {
    assertBounded(request.project.addresses, 'addresses');
    assertBounded(request.selection, 'selection');
    assertBounded(request.semanticModelName, 'semanticModelName');
    const version = request.ossieVersion ?? '0.1.1';
    if (version !== '0.1.1' && version !== '0.2.0.dev0') {
      fail(
        'invalid_ossie_document',
        'ossieVersion',
        `Unsupported Ossie version ${String(version)}.`,
        'Use Ossie 0.1.1 or 0.2.0.dev0.'
      );
    }
    if (!request.semanticModelName) {
      fail(
        'native_incomplete',
        'semanticModelName',
        'A semantic model name is required.',
        'Supply a non-empty semantic model name.'
      );
    }
    if (
      'all' in request.selection &&
      request.selection.all === true &&
      'selectors' in request.selection &&
      Array.isArray(request.selection.selectors) &&
      request.selection.selectors.length
    ) {
      fail(
        'native_incomplete',
        'selection',
        'Select all datasets or supply explicit selectors, not both.',
        'Remove --all or remove the explicit selectors.'
      );
    }
    const project = parseProject(request, result);
    if (!project.datasets.length) {
      fail(
        'native_incomplete',
        'project#datasets',
        'This Project has no sources or models, so there is nothing to export.',
        'Add a source or model to the Blueprint, then export again.'
      );
    }
    const selected = withoutUnlistedColumns(
      selectedDatasets(project.datasets, request.selection),
      request.selection,
      result
    );
    const selectedReferences = new Set(selected.map((dataset) => dataset.reference));
    const selectedNames = new Set<string>();
    for (const dataset of selected) {
      if (selectedNames.has(dataset.name)) {
        fail(
          'duplicate_identity',
          dataset.path,
          `More than one selected dataset has Ossie name ${dataset.name}.`,
          'Export colliding source names in separate semantic models.',
          objectReference(dataset.name)
        );
      }
      selectedNames.add(dataset.name);
    }
    const byReference = new Map(project.datasets.map((dataset) => [dataset.reference, dataset]));
    if (version === '0.2.0.dev0') {
      addDependencyDiagnostics(selected, selectedReferences, result);
    }
    const semanticModel = {
      name: request.semanticModelName,
      ...exportVerifiedQueries(request, selectedReferences, result),
      datasets: selected.map((dataset) => outputDataset(dataset, request, version, result)),
      relationships: outputRelationships(
        project.relationships,
        selectedReferences,
        byReference,
        version,
        result
      ),
      metrics: outputMetrics(project.metrics, selectedReferences, byReference, version, result),
    };
    const document =
      version === '0.1.1'
        ? { version, semantic_model: [semanticModel] }
        : { version, ...semanticModel };
    assertBounded(document, 'the exported Ossie document', {
      maxBytes: OSSIE_EXPORT_MAX_BYTES,
      maxNodes: OSSIE_EXPORT_MAX_NODES,
    });
    readOssieProfile(document, 'export.yml');
    result.files.push(
      file(`ossie/${identity(`${version}\0${request.semanticModelName}`)}.yml`, document)
    );
    result.ok = true;
    result.ready = !(request.strict && result.diagnostics.some(blocksStrictConversion));
  } catch (error) {
    result.files = [];
    if (error instanceof ExportFailure || error instanceof VerifiedQueryFailure) {
      result.diagnostics.push(
        diagnostic(
          error.code,
          error.diagnosticPath,
          error.message,
          'error',
          error.objectReference,
          error.remedy
        )
      );
    } else {
      result.diagnostics.push(
        diagnostic(
          'native_incomplete',
          'project',
          errorMessage(error),
          'error',
          objectReference(),
          'Correct the native project data and retry the export.'
        )
      );
    }
  }
  return result;
}

/** Compatibility wrapper for callers of the first converter API. */
export function exportOssieDocuments(
  inputs: readonly NativeInterchangeInput[],
  options: ExportOssieOptions = {}
): ConversionResult {
  const ontologyInputs = inputs.filter((input) =>
    ['ontology', 'ontology_mapping'].includes(String(record(input.document)['type']))
  );
  if (ontologyInputs.length) {
    const ontology = exportOntologyDocuments(ontologyInputs, {
      ...options,
      ossieVersion: options.ossieVersion ?? '0.1.1',
    });
    if (!ontology.ok) return ontology;
    const semanticInputs = inputs.filter((input) => !ontologyInputs.includes(input));
    if (!semanticInputs.length) return ontology;
    const mappings = ontologyInputs.filter(
      (input) => record(input.document)['type'] === 'ontology_mapping'
    );
    const semantic = mappings.length
      ? exportOntologyScopes(mappings, semanticInputs, options, exportOssieDocument)
      : exportOssieDocuments(semanticInputs, options);
    if (!semantic.ok) return { ...semantic, files: [] };
    return {
      ok: true,
      ready: semantic.ready,
      files: [...ontology.files, ...semantic.files],
      diagnostics: [...ontology.diagnostics, ...semantic.diagnostics],
    };
  }
  const sources: unknown[] = [];
  const models: unknown[] = [];
  const metrics: unknown[] = [];
  const relationships: unknown[] = [];
  const verifiedQueries: unknown[] = [];
  for (const input of inputs) {
    const value = record(input.document);
    if (value['type'] === 'source') sources.push(value);
    else if (value['type'] === 'model') models.push(value);
    else if (value['type'] === 'metric') metrics.push(value);
    else if (value['type'] === 'relationship') relationships.push(value);
    else if (value['type'] === 'vq') verifiedQueries.push(value);
  }
  return exportOssieDocument({
    project: {
      sources,
      models,
      metrics,
      relationships,
      verifiedQueries,
      addresses: options.addresses ?? {},
    },
    semanticModelName: options.name ?? 'track_export',
    selection: { all: true },
    ossieVersion: options.ossieVersion ?? '0.2.0.dev0',
    strict: options.strict,
  });
}
