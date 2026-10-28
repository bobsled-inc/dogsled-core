import { z } from 'zod';

import {
  SourceSpecSchema,
  TransformSpecSchema,
  WarehouseTableSourceSchema,
} from '../compiler/schemas.js';
import { MetricSpecSchema } from '../entities/metric.js';
import { RelationshipSpecSchema } from '../entities/relationship.js';
import { readOssieProfile } from '../ossie/profiles.js';
import type {
  OssieDataset,
  OssieField,
  OssieMetric,
  OssieRelationship,
  OssieSemanticModel,
} from '../ossie/profile-types.js';
import { logicalTypeForSqlType } from '../ossie/types.js';
import { fieldExtensionSchema } from '../ossie/translate.js';
import {
  assertBounded,
  diagnostic,
  errorMessage,
  extensions,
  file,
  identity,
  parseOssieYaml,
  OSSIE_VENDOR,
  type ConversionObjectReference,
  type ConversionResult,
} from './common.js';
import type { OssieCustomExtension, OssieDatasetInterchange } from './storage.js';
import {
  normalizeSqlType,
  outputPath,
  physicalColumn,
  remapMetricExpression,
  remapReferences,
} from './import-helpers.js';
import { importVerifiedQueries, VerifiedQueryFailure } from './verified-queries.js';
import type {
  ImportOssieDocumentsRequest,
  ImportOssieOptions,
  OssieConnectionContext,
  OssiePhysicalSchema,
} from './import-types.js';

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const connectionHandle = /^[A-Za-z_][A-Za-z0-9_-]*$/;

interface DatasetExtension {
  version?: '1' | '2';
  kind: 'source' | 'derived';
  settings: Record<string, unknown>;
  grain?: unknown;
  build?: Record<string, unknown>;
}

interface DatasetTarget {
  nativeReference?: string;
  fieldNames: Set<string>;
}

class ImportFailure extends Error {
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

const sourceExtensionKeys = new Set([
  'extension_version',
  'kind',
  'source_type',
  'connection',
  'trust_tier',
  'quality',
  'integration',
  'resource',
  'filter',
  'max_age',
  'mode',
  'refresh',
  'destination',
]);
const derivedExtensionKeys = new Set(['extension_version', 'kind', 'grain', 'build']);
const rejectedBuildKeys = new Set([
  'include_all_columns',
  'exclude_columns',
  'derived_columns',
  'pivot',
  'unpivot',
  'flatten_json',
  'hierarchy',
  'recurse',
]);

function ref(documentPath: string, dataset?: string, field?: string): ConversionObjectReference {
  return { documentPath, ...(dataset ? { dataset } : {}), ...(field ? { field } : {}) };
}

function addDiagnostic(
  result: ConversionResult,
  code: string,
  severity: 'error' | 'warning',
  path: string,
  objectReference: ConversionObjectReference,
  message: string,
  remedy: string
): void {
  result.diagnostics.push(diagnostic(code, path, message, severity, objectReference, remedy));
}

function fail(
  code: string,
  path: string,
  objectReference: ConversionObjectReference,
  message: string,
  remedy: string
): never {
  throw new ImportFailure(code, path, message, objectReference, remedy);
}

function dogsledExtension(
  owner: { custom_extensions?: OssieCustomExtension[] },
  path: string,
  objectReference: ConversionObjectReference
): Record<string, unknown> | undefined {
  const entries = extensions(owner).filter((entry) => entry.vendor_name === OSSIE_VENDOR);
  if (entries.length > 1) {
    fail(
      'invalid_dogsled_extension',
      path,
      objectReference,
      'An owner can contain only one DOGSLED extension.',
      'Remove the duplicate DOGSLED extension.'
    );
  }
  if (!entries[0]) return undefined;
  try {
    const parsed: unknown = JSON.parse(entries[0].data);
    assertBounded(parsed);
    return z.record(z.string(), z.unknown()).parse(parsed);
  } catch (error) {
    fail(
      'invalid_dogsled_extension',
      path,
      objectReference,
      `DOGSLED extension data must be a bounded JSON object: ${errorMessage(error)}`,
      'Replace the extension data with a valid JSON object string.'
    );
  }
}

function parseDatasetExtension(
  dataset: OssieDataset,
  path: string,
  objectReference: ConversionObjectReference
): DatasetExtension {
  const extension = dogsledExtension(dataset, path, objectReference);
  if (!extension) return { kind: 'source', settings: {} };
  const version = extension['extension_version'];
  if (version !== '1' && version !== '2') {
    fail(
      version === undefined ? 'invalid_dogsled_extension' : 'unsupported_extension_version',
      path,
      objectReference,
      'DOGSLED extension_version must be "1" or "2".',
      'Use a supported DOGSLED extension version.'
    );
  }
  const kind = extension['kind'] ?? 'source';
  if (kind !== 'source' && kind !== 'derived') {
    fail(
      'unsupported_kind',
      path,
      objectReference,
      'DOGSLED kind must be source or derived.',
      'Set kind to source or derived.'
    );
  }
  const allowed = kind === 'source' ? sourceExtensionKeys : derivedExtensionKeys;
  const unknown = Object.keys(extension).find((key) => !allowed.has(key));
  if (unknown) {
    fail(
      'invalid_dogsled_extension',
      `${path}.${unknown}`,
      objectReference,
      `Unknown DOGSLED dataset property ${unknown}.`,
      'Remove the unsupported property.'
    );
  }
  if (kind === 'derived') {
    const build = z.record(z.string(), z.unknown()).safeParse(extension['build'] ?? {});
    if (!build.success) {
      fail(
        'invalid_dogsled_extension',
        `${path}.build`,
        objectReference,
        'DOGSLED build must be an object.',
        'Use an object for build settings.'
      );
    }
    const rejected = Object.keys(build.data).find((key) => rejectedBuildKeys.has(key));
    if (rejected) {
      fail(
        'invalid_dogsled_extension',
        `${path}.build.${rejected}`,
        objectReference,
        `${rejected} needs an explicit final field mapping and is not supported.`,
        'List the final output fields explicitly before importing.'
      );
    }
    return { version, kind, settings: {}, grain: extension['grain'], build: build.data };
  }
  const settings = Object.fromEntries(
    Object.entries(extension).filter(([key]) => key !== 'extension_version' && key !== 'kind')
  );
  return { version, kind, settings };
}

function foreignExtensions(owner: {
  custom_extensions?: OssieCustomExtension[];
}): OssieCustomExtension[] {
  return extensions(owner).filter((entry) => entry.vendor_name !== OSSIE_VENDOR);
}

function addLegacyVendorDiagnostic(
  result: ConversionResult,
  owner: { custom_extensions?: OssieCustomExtension[] },
  path: string,
  objectReference: ConversionObjectReference
): void {
  if (!foreignExtensions(owner).some((entry) => entry.vendor_name === 'TRACK')) return;
  addDiagnostic(
    result,
    'legacy_vendor',
    'warning',
    path,
    objectReference,
    'The TRACK extension was preserved as foreign data and was not interpreted.',
    'Use DOGSLED metadata when native conversion behavior is required.'
  );
}

function sourceConnection(
  dataset: OssieDataset,
  extension: DatasetExtension,
  documentPath: string,
  context: OssieConnectionContext | undefined,
  result: ConversionResult
): string | undefined {
  const objectReference = ref(documentPath, dataset.name);
  const path = `${documentPath}#datasets.${dataset.name}.connection`;
  const bindings = (context?.datasetBindings ?? []).filter(
    (binding) => binding.documentPath === documentPath && binding.dataset === dataset.name
  );
  if (bindings.length > 1) {
    fail(
      'invalid_dogsled_extension',
      path,
      objectReference,
      'More than one connection binding matched this dataset.',
      'Keep one binding for this document and dataset.'
    );
  }
  const imported =
    typeof extension.settings['connection'] === 'string'
      ? extension.settings['connection']
      : undefined;
  const aliased = imported ? (context?.connectionAliases?.[imported] ?? imported) : undefined;
  const resolved = bindings[0]?.connection ?? aliased ?? context?.defaultConnection;
  if (resolved && !connectionHandle.test(resolved)) {
    fail(
      'invalid_dogsled_extension',
      path,
      objectReference,
      `Invalid connection handle ${resolved}.`,
      'Use a non-empty Dogsled connection handle.'
    );
  }
  if (imported && resolved && imported !== resolved) {
    addDiagnostic(
      result,
      'connection_rebound',
      'warning',
      path,
      objectReference,
      `Connection ${imported} was rebound to ${resolved}.`,
      'Review the destination connection before using the imported source.'
    );
  }
  if (!resolved) {
    addDiagnostic(
      result,
      'connection_required',
      'error',
      path,
      objectReference,
      'This source has no Dogsled connection.',
      'Supply a dataset binding, connection alias, or default connection.'
    );
  }
  return resolved;
}

function physicalSchema(
  dataset: OssieDataset,
  documentPath: string,
  connection: string | undefined,
  schemas: OssiePhysicalSchema[] | undefined,
  result: ConversionResult
): OssiePhysicalSchema | undefined {
  const candidates = (schemas ?? []).filter(
    (schema) => schema.documentPath === documentPath && schema.dataset === dataset.name
  );
  if (!candidates.length) return undefined;
  const match = candidates.find(
    (schema) => schema.connection === connection && schema.source === dataset.source
  );
  if (match) return match;
  addDiagnostic(
    result,
    'physical_schema_mismatch',
    'error',
    `${documentPath}#datasets.${dataset.name}`,
    ref(documentPath, dataset.name),
    'The supplied physical schema identifies a different source or connection.',
    'Supply a schema for the exact document, dataset, connection, and source address.'
  );
  return undefined;
}

function fieldInterchange(
  field: OssieField,
  origin: string
): NonNullable<OssieDatasetInterchange['fields']>[number] | undefined {
  const customExtensions = foreignExtensions(field);
  if (!customExtensions.length) return undefined;
  return { origin_id: origin, field: field.name, custom_extensions: customExtensions };
}

function convertFields(
  dataset: OssieDataset,
  extension: DatasetExtension,
  documentPath: string,
  semanticIndex: number,
  schema: OssiePhysicalSchema | undefined,
  result: ConversionResult
): { columns: Record<string, unknown>[]; interchange?: OssieDatasetInterchange } {
  const seen = new Set<string>();
  const mappedPhysical = new Set<string>();
  const ownerFields: NonNullable<OssieDatasetInterchange['fields']> = [];
  const columns = (dataset.fields ?? []).map((field) => {
    const objectReference = ref(documentPath, dataset.name, field.name);
    const path = `${documentPath}#datasets.${dataset.name}.fields.${field.name}`;
    if (seen.has(field.name.toLowerCase())) {
      fail(
        'duplicate_identity',
        path,
        objectReference,
        `Duplicate field ${field.name}.`,
        'Give every field in a dataset a unique name.'
      );
    }
    seen.add(field.name.toLowerCase());
    addLegacyVendorDiagnostic(result, field, path, objectReference);
    const rawFieldExtension = dogsledExtension(field, path, objectReference) ?? {};
    const parsedFieldExtension = fieldExtensionSchema.safeParse(rawFieldExtension);
    if (!parsedFieldExtension.success) {
      fail(
        'invalid_dogsled_extension',
        path,
        objectReference,
        parsedFieldExtension.error.issues.map((issue) => issue.message).join('; '),
        'Remove unsupported field extension properties.'
      );
    }
    const { build_expression, sql_type, ...nativeMetadata } = parsedFieldExtension.data;
    if (extension.kind === 'source' && build_expression) {
      fail(
        'invalid_dogsled_extension',
        path,
        objectReference,
        'A source field cannot contain build_expression.',
        'Remove build_expression or import the dataset as derived.'
      );
    }
    const matched = schema ? physicalColumn(field.name, schema) : undefined;
    if (matched === 'ambiguous') {
      addDiagnostic(
        result,
        'physical_field_ambiguous',
        'error',
        path,
        objectReference,
        'More than one physical column matches this Ossie field.',
        'Use an exact field name or correct the supplied physical schema.'
      );
    } else if (schema && !matched) {
      addDiagnostic(
        result,
        'physical_field_required',
        'error',
        path,
        objectReference,
        'The supplied physical schema does not contain this Ossie field.',
        'Add the field to the physical table or correct the Ossie field name.'
      );
    } else if (matched) {
      mappedPhysical.add(matched.name);
    }
    const physicalType = matched && matched !== 'ambiguous' ? matched.sqlType : undefined;
    if (sql_type && physicalType && normalizeSqlType(sql_type) !== normalizeSqlType(physicalType)) {
      addDiagnostic(
        result,
        'physical_type_conflict',
        'error',
        path,
        objectReference,
        `DOGSLED sql_type ${sql_type} conflicts with physical type ${physicalType}.`,
        'Make the DOGSLED sql_type match the selected physical column.'
      );
    }
    const exactType = sql_type ?? physicalType;
    if (
      extension.kind === 'source' &&
      !exactType &&
      matched !== 'ambiguous' &&
      !(schema && !matched)
    ) {
      addDiagnostic(
        result,
        'physical_type_required',
        'error',
        `${path}.type`,
        objectReference,
        'This source field has no exact physical SQL type.',
        'Supply DOGSLED sql_type or a matching physical schema.'
      );
    }
    if (exactType && field.datatype && logicalTypeForSqlType(exactType) !== field.datatype) {
      addDiagnostic(
        result,
        'logical_type_conflict',
        'error',
        path,
        objectReference,
        `Physical type ${exactType} conflicts with Ossie datatype ${field.datatype}.`,
        'Correct the logical datatype or the exact physical type.'
      );
    }
    if (field.label !== undefined) {
      addDiagnostic(
        result,
        'unsupported_metadata_not_preserved',
        'warning',
        `${path}.label`,
        objectReference,
        'Dogsled does not preserve the Ossie field label in this release.',
        'Keep the label in the source Ossie document if it is still needed.'
      );
    }
    const owned = fieldInterchange(
      field,
      identity(`${documentPath}\0${semanticIndex}\0${dataset.name}\0${field.name}`)
    );
    if (owned) ownerFields.push(owned);
    return {
      ...nativeMetadata,
      name: field.name,
      ...(field.description !== undefined ? { description: field.description } : {}),
      ...(exactType ? { type: exactType } : {}),
      ...(dataset.primary_key?.includes(field.name) ? { primary_key: true } : {}),
      ...(extension.kind === 'derived' && build_expression ? { expr: build_expression } : {}),
      semantic_expression: field.expression,
      ...(field.dimension?.is_time !== undefined ? { is_time: field.dimension.is_time } : {}),
      ...(field.ai_context !== undefined ? { ai_context: field.ai_context } : {}),
    };
  });
  for (const column of schema?.columns ?? []) {
    if (mappedPhysical.has(column.name)) continue;
    addDiagnostic(
      result,
      'physical_field_unmapped',
      'warning',
      `${documentPath}#datasets.${dataset.name}.fields`,
      ref(documentPath, dataset.name),
      `Physical column ${column.name} is not present in the Ossie field list.`,
      'Add it to Ossie if it should be part of the semantic dataset.'
    );
  }
  const customExtensions = foreignExtensions(dataset);
  const interchange =
    customExtensions.length || ownerFields.length
      ? {
          ...(customExtensions.length ? { custom_extensions: customExtensions } : {}),
          ...(ownerFields.length ? { fields: ownerFields } : {}),
        }
      : undefined;
  return { columns, ...(interchange ? { interchange } : {}) };
}

function addNativeIssues(
  result: ConversionResult,
  parsed: { success: true } | { success: false; error: z.ZodError },
  documentPath: string,
  dataset: string,
  basePath: string
): void {
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    const key = issue.path.at(-1);
    if (key === 'connection' || key === 'type') continue;
    addDiagnostic(
      result,
      'native_incomplete',
      'error',
      `${basePath}.${issue.path.join('.')}`,
      ref(documentPath, dataset),
      issue.message,
      'Complete the missing or invalid Dogsled property in the generated draft.'
    );
  }
}

function entityInterchange(owner: {
  custom_extensions?: OssieCustomExtension[];
}): Record<string, unknown> | undefined {
  const customExtensions = foreignExtensions(owner);
  return customExtensions.length ? { ossie: { custom_extensions: customExtensions } } : undefined;
}

function selectedMetricExpression(metric: OssieMetric): string | undefined {
  const ansi = metric.expression.dialects.find((entry) => entry.dialect === 'ANSI_SQL');
  if (ansi) return ansi.expression;
  return metric.expression.dialects.length === 1
    ? metric.expression.dialects[0]?.expression
    : undefined;
}

function metricExtension(
  metric: OssieMetric,
  path: string,
  objectReference: ConversionObjectReference
): { datasets?: string[]; expression?: string; synonyms?: string[]; tags?: string[] } {
  const extension = dogsledExtension(metric, path, objectReference);
  if (!extension) return {};
  if (extension['extension_version'] === undefined) {
    const parsed = z
      .object({ tags: z.array(z.string()).optional() })
      .strict()
      .safeParse(extension);
    if (parsed.success) return parsed.data;
  } else if (extension['extension_version'] === '2') {
    const parsed = z
      .object({
        extension_version: z.literal('2'),
        datasets: z.array(z.string()).min(1),
        expression: z.string().min(1),
        synonyms: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict()
      .safeParse(extension);
    if (parsed.success) return parsed.data;
  } else {
    fail(
      'unsupported_extension_version',
      path,
      objectReference,
      'Unsupported DOGSLED metric extension version.',
      'Use extension version 2.'
    );
  }
  fail(
    'invalid_dogsled_extension',
    path,
    objectReference,
    'Invalid DOGSLED metric extension.',
    'Use the documented metric extension properties.'
  );
}

function relationshipExtension(
  relationship: OssieRelationship,
  path: string,
  objectReference: ConversionObjectReference
): {
  left_side?: 'from' | 'to';
  relationship_type?: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  join_type?: 'inner' | 'left';
  description?: string;
  tags?: string[];
} {
  const extension = dogsledExtension(relationship, path, objectReference);
  if (!extension) return {};
  const base = {
    join_type: z.enum(['inner', 'left']).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  };
  if (extension['extension_version'] === undefined) {
    const parsed = z.object(base).strict().safeParse(extension);
    if (parsed.success) return parsed.data;
  } else if (extension['extension_version'] === '2') {
    const parsed = z
      .object({
        extension_version: z.literal('2'),
        left_side: z.enum(['from', 'to']),
        relationship_type: z.enum(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']),
        ...base,
      })
      .strict()
      .safeParse(extension);
    if (parsed.success) return parsed.data;
  } else {
    fail(
      'unsupported_extension_version',
      path,
      objectReference,
      'Unsupported DOGSLED relationship extension version.',
      'Use extension version 2.'
    );
  }
  fail(
    'invalid_dogsled_extension',
    path,
    objectReference,
    'Invalid DOGSLED relationship extension.',
    'Use the documented relationship extension properties.'
  );
}

function datasetReferences(
  names: string[],
  targets: Map<string, DatasetTarget>,
  path: string,
  objectReference: ConversionObjectReference,
  result: ConversionResult
): string[] | undefined {
  const resolved: string[] = [];
  for (const name of names) {
    const target = targets.get(name);
    if (!target?.nativeReference) {
      addDiagnostic(
        result,
        'metadata_reference_required',
        'error',
        path,
        objectReference,
        `Dataset reference ${name} does not resolve to an imported native dataset.`,
        'Import the referenced dataset and supply its required connection details.'
      );
      return undefined;
    }
    if (!resolved.includes(target.nativeReference)) resolved.push(target.nativeReference);
  }
  return resolved;
}

function metricDatasetNames(
  metric: OssieMetric,
  extension: ReturnType<typeof metricExtension>,
  model: OssieSemanticModel
): string[] | undefined {
  if (extension.datasets) return extension.datasets;
  const expression = selectedMetricExpression(metric);
  const qualified = expression
    ? [...expression.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\.[^}]+\}/g)].map((match) => match[1]!)
    : [];
  if (qualified.length) return [...new Set(qualified)];
  return model.datasets.length === 1 ? [model.datasets[0]!.name] : undefined;
}

function convertMetric(
  metric: OssieMetric,
  model: OssieSemanticModel,
  targets: Map<string, DatasetTarget>,
  documentPath: string,
  result: ConversionResult,
  aliases: Record<string, string> | undefined
): Record<string, unknown> | undefined {
  const objectReference = ref(documentPath);
  const path = `${documentPath}#metrics.${metric.name}`;
  if (!identifier.test(metric.name)) {
    fail(
      'native_identifier_not_supported',
      path,
      objectReference,
      `Metric name ${metric.name} is not a valid Dogsled identifier.`,
      'Rename the metric and update its references.'
    );
  }
  addLegacyVendorDiagnostic(result, metric, path, objectReference);
  const extension = metricExtension(metric, path, objectReference);
  const names = metricDatasetNames(metric, extension, model);
  if (!names) {
    addDiagnostic(
      result,
      'metric_dataset_reference_required',
      'error',
      path,
      objectReference,
      'Dogsled cannot determine which datasets this metric uses.',
      'Add DOGSLED dataset references or qualify a dataset in the metric expression.'
    );
    return undefined;
  }
  const references = datasetReferences(names, targets, path, objectReference, result);
  if (!references) return undefined;
  const selectedExpression = extension.expression ?? selectedMetricExpression(metric);
  if (!selectedExpression) {
    addDiagnostic(
      result,
      'metric_expression_default_required',
      'error',
      path,
      objectReference,
      'Dogsled cannot select one native metric expression.',
      'Add an ANSI_SQL expression or a DOGSLED native expression.'
    );
    return undefined;
  }
  const expression = remapMetricExpression(selectedExpression, aliases);
  const interchange = entityInterchange(metric);
  const native: Record<string, unknown> = {
    spec_version: '0.2',
    type: 'metric',
    name: metric.name,
    ...(metric.description !== undefined ? { description: metric.description } : {}),
    ...(references.length === 1 ? { model: references[0] } : { models: references }),
    expression,
    ...(metric.datatype !== undefined ? { datatype: metric.datatype } : {}),
    semantic_expression: metric.expression,
    ...(metric.ai_context !== undefined ? { ai_context: metric.ai_context } : {}),
    ...(extension.synonyms ? { synonyms: extension.synonyms } : {}),
    ...(extension.tags ? { tags: extension.tags } : {}),
    ...(interchange ? { interchange } : {}),
  };
  const parsed = MetricSpecSchema.safeParse(native);
  if (!parsed.success) {
    addDiagnostic(
      result,
      'native_incomplete',
      'error',
      path,
      objectReference,
      parsed.error.issues.map((issue) => issue.message).join('; '),
      'Complete the metric in the generated Dogsled draft.'
    );
    return undefined;
  }
  return native;
}

function convertRelationship(
  relationship: OssieRelationship,
  targets: Map<string, DatasetTarget>,
  documentPath: string,
  result: ConversionResult
): Record<string, unknown> | undefined {
  const objectReference = ref(documentPath);
  const path = `${documentPath}#relationships.${relationship.name}`;
  if (!identifier.test(relationship.name)) {
    fail(
      'native_identifier_not_supported',
      path,
      objectReference,
      `Relationship name ${relationship.name} is not a valid Dogsled identifier.`,
      'Rename the relationship and update its references.'
    );
  }
  addLegacyVendorDiagnostic(result, relationship, path, objectReference);
  const extension = relationshipExtension(relationship, path, objectReference);
  if (relationship.from_columns.length !== relationship.to_columns.length) {
    addDiagnostic(
      result,
      'metadata_reference_required',
      'error',
      path,
      objectReference,
      'Relationship column arrays must have the same length.',
      'Provide one matching to column for every from column.'
    );
    return undefined;
  }
  const from = targets.get(relationship.from);
  const to = targets.get(relationship.to);
  if (!from?.nativeReference || !to?.nativeReference) {
    addDiagnostic(
      result,
      'metadata_reference_required',
      'error',
      path,
      objectReference,
      'Relationship datasets do not resolve to imported native datasets.',
      'Import both datasets and supply required source connections.'
    );
    return undefined;
  }
  for (const [side, target, names] of [
    ['from', from, relationship.from_columns],
    ['to', to, relationship.to_columns],
  ] as const) {
    const missing = names.find((name) => !target.fieldNames.has(name));
    if (missing) {
      addDiagnostic(
        result,
        'metadata_reference_required',
        'error',
        path,
        objectReference,
        `Relationship ${side} column ${missing} does not exist.`,
        'Correct the relationship column reference.'
      );
      return undefined;
    }
  }
  const flip = extension.left_side === 'to';
  const left = flip ? to : from;
  const right = flip ? from : to;
  const leftColumns = flip ? relationship.to_columns : relationship.from_columns;
  const rightColumns = flip ? relationship.from_columns : relationship.to_columns;
  const joinType = extension.join_type ?? 'inner';
  if (!extension.join_type) {
    addDiagnostic(
      result,
      'relationship_join_type_defaulted',
      'warning',
      path,
      objectReference,
      'The relationship join type defaulted to inner.',
      'Add DOGSLED relationship metadata when another join type is required.'
    );
  }
  const interchange = entityInterchange(relationship);
  const native: Record<string, unknown> = {
    spec_version: '0.2',
    type: 'relationship',
    name: relationship.name,
    ...(extension.description ? { description: extension.description } : {}),
    left_model: left.nativeReference,
    right_model: right.nativeReference,
    join_columns: leftColumns.map((column, index) => ({
      left: column,
      right: rightColumns[index],
    })),
    join_type: joinType,
    relationship_type: extension.relationship_type ?? 'many_to_one',
    ...(extension.tags ? { tags: extension.tags } : {}),
    ...(relationship.ai_context !== undefined ? { ai_context: relationship.ai_context } : {}),
    ...(interchange ? { interchange } : {}),
  };
  const parsed = RelationshipSpecSchema.safeParse(native);
  if (!parsed.success) {
    addDiagnostic(
      result,
      'native_incomplete',
      'error',
      path,
      objectReference,
      parsed.error.issues.map((issue) => issue.message).join('; '),
      'Complete the relationship in the generated Dogsled draft.'
    );
    return undefined;
  }
  return native;
}

function validateNativeIdentity(name: string, documentPath: string, dataset: string): void {
  if (identifier.test(name)) return;
  fail(
    'native_identifier_not_supported',
    `${documentPath}#datasets.${dataset}.name`,
    ref(documentPath, dataset),
    `Dataset name ${name} is not a valid Dogsled identifier.`,
    'Rename the dataset and update its references.'
  );
}

function convertSemanticModel(
  model: OssieSemanticModel,
  semanticIndex: number,
  documentPath: string,
  request: ImportOssieDocumentsRequest,
  result: ConversionResult,
  identities: Set<string>
): void {
  addDiagnostic(
    result,
    'semantic_model_metadata_not_preserved',
    'warning',
    `${documentPath}#semantic_model.${model.name}`,
    ref(documentPath),
    'Dogsled preserves supported verified queries but does not preserve other semantic-model-level data.',
    'Keep the original Ossie document if this container data is still needed.'
  );
  const targets = new Map<string, DatasetTarget>();
  const queryReferences = new Map<string, string>();
  for (const dataset of model.datasets) {
    validateNativeIdentity(dataset.name, documentPath, dataset.name);
    if (targets.has(dataset.name)) {
      fail(
        'duplicate_identity',
        `${documentPath}#datasets.${dataset.name}`,
        ref(documentPath, dataset.name),
        `Duplicate dataset ${dataset.name}.`,
        'Give every dataset in a semantic model a unique name.'
      );
    }
    const path = `${documentPath}#datasets.${dataset.name}`;
    const objectReference = ref(documentPath, dataset.name);
    addLegacyVendorDiagnostic(result, dataset, path, objectReference);
    const extension = parseDatasetExtension(dataset, path, objectReference);
    if (dataset.unique_keys?.length) {
      addDiagnostic(
        result,
        'unique_keys_not_preserved',
        'warning',
        `${path}.unique_keys`,
        objectReference,
        'Dogsled does not preserve Ossie unique_keys in this release.',
        'Keep unique key definitions in the original Ossie document.'
      );
    }
    const connection =
      extension.kind === 'source'
        ? sourceConnection(dataset, extension, documentPath, request.context?.connections, result)
        : undefined;
    const schema =
      extension.kind === 'source'
        ? physicalSchema(
            dataset,
            documentPath,
            connection,
            request.context?.physicalSchemas,
            result
          )
        : undefined;
    const convertedFields = convertFields(
      dataset,
      extension,
      documentPath,
      semanticIndex,
      schema,
      result
    );
    const interchange = convertedFields.interchange
      ? { ossie: convertedFields.interchange }
      : undefined;
    let native: Record<string, unknown>;
    let nativeReference: string | undefined;
    let kind: 'source' | 'model';
    if (extension.kind === 'source') {
      kind = 'source';
      const sourceType = extension.settings['source_type'] ?? 'warehouse_table';
      native = {
        ...extension.settings,
        spec_version: '0.2',
        type: 'source',
        name: dataset.name,
        ...(dataset.description !== undefined ? { description: dataset.description } : {}),
        ...(dataset.ai_context !== undefined ? { ai_context: dataset.ai_context } : {}),
        source_type: sourceType,
        ...(connection ? { connection } : {}),
        schema: { columns: convertedFields.columns },
        ...(sourceType === 'warehouse_table' ? { table: dataset.source } : {}),
        ...(interchange ? { interchange } : {}),
      };
      if (
        sourceType === 'warehouse_table' &&
        !WarehouseTableSourceSchema.shape.table.safeParse(dataset.source).success
      ) {
        addDiagnostic(
          result,
          'invalid_source_address',
          'error',
          `${path}.source`,
          objectReference,
          `${dataset.source} is not a valid warehouse table address.`,
          'Use a valid database, schema, and table address for the selected warehouse.'
        );
      }
      addNativeIssues(result, SourceSpecSchema.safeParse(native), documentPath, dataset.name, path);
      nativeReference = connection ? `${connection}.${dataset.name}` : undefined;
    } else {
      kind = 'model';
      const build = structuredClone(extension.build ?? {});
      remapReferences(build, request.context?.connections?.connectionAliases);
      native = {
        ...build,
        spec_version: '0.2',
        type: 'model',
        name: dataset.name,
        ...(dataset.description !== undefined ? { description: dataset.description } : {}),
        ...(dataset.ai_context !== undefined ? { ai_context: dataset.ai_context } : {}),
        ...(extension.grain !== undefined ? { grain: extension.grain } : {}),
        columns: convertedFields.columns,
        ...(interchange ? { interchange } : {}),
      };
      addNativeIssues(
        result,
        TransformSpecSchema.safeParse(native),
        documentPath,
        dataset.name,
        path
      );
      nativeReference = dataset.name;
    }
    if (nativeReference) {
      const originalConnection = extension.settings['connection'];
      const originalReference =
        kind === 'source' && typeof originalConnection === 'string'
          ? `${originalConnection}.${dataset.name}`
          : dataset.name;
      queryReferences.set(originalReference, nativeReference);
    }
    const key = kind === 'source' ? `${connection ?? '?'}.${dataset.name}` : dataset.name;
    const identityKey = `${kind}:${key}`;
    if (identities.has(identityKey)) {
      fail(
        'duplicate_identity',
        path,
        objectReference,
        `More than one input creates native ${identityKey}.`,
        'Remove the duplicate or use a different native identity.'
      );
    }
    identities.add(identityKey);
    result.files.push(file(outputPath(kind, key), native));
    targets.set(dataset.name, {
      nativeReference,
      fieldNames: new Set((dataset.fields ?? []).map((field) => field.name)),
    });
  }
  importVerifiedQueries(
    model,
    documentPath,
    request.context?.connections,
    queryReferences,
    identities,
    result
  );
  for (const metric of model.metrics ?? []) {
    const native = convertMetric(
      metric,
      model,
      targets,
      documentPath,
      result,
      request.context?.connections?.connectionAliases
    );
    if (!native) continue;
    const identityKey = `metric:${metric.name}`;
    if (identities.has(identityKey)) {
      fail(
        'duplicate_identity',
        `${documentPath}#metrics.${metric.name}`,
        ref(documentPath),
        `More than one input creates native ${identityKey}.`,
        'Give every imported metric a unique name.'
      );
    }
    identities.add(identityKey);
    result.files.push(file(outputPath('metric', metric.name), native));
  }
  for (const relationship of model.relationships ?? []) {
    const native = convertRelationship(relationship, targets, documentPath, result);
    if (!native) continue;
    const identityKey = `relationship:${relationship.name}`;
    if (identities.has(identityKey)) {
      fail(
        'duplicate_identity',
        `${documentPath}#relationships.${relationship.name}`,
        ref(documentPath),
        `More than one input creates native ${identityKey}.`,
        'Give every imported relationship a unique name.'
      );
    }
    identities.add(identityKey);
    result.files.push(file(outputPath('relationship', relationship.name), native));
  }
}

export function importOssieDocuments(request: ImportOssieDocumentsRequest): ConversionResult {
  const result: ConversionResult = { ok: false, ready: false, files: [], diagnostics: [] };
  const parsed: Array<{
    path: string;
    semanticIndex: number;
    model: OssieSemanticModel;
  }> = [];
  let fatal = false;
  for (const input of request.documents) {
    try {
      if (!/\.ya?ml$/i.test(input.path)) {
        throw new Error(`${input.path}: Ossie import accepts .yml and .yaml files only`);
      }
      const document = parseOssieYaml(input.content, input.path);
      const profile = readOssieProfile(document, input.path);
      profile.semanticModels.forEach((model, semanticIndex) => {
        parsed.push({ path: input.path, semanticIndex, model });
      });
    } catch (error) {
      fatal = true;
      addDiagnostic(
        result,
        'invalid_ossie_document',
        'error',
        input.path,
        ref(input.path),
        errorMessage(error),
        'Validate the YAML against Ossie 0.1.1 or 0.2.0.dev0.'
      );
    }
  }
  if (fatal) return result;
  const identities = new Set<string>();
  try {
    for (const entry of parsed) {
      convertSemanticModel(
        entry.model,
        entry.semanticIndex,
        entry.path,
        request,
        result,
        identities
      );
    }
  } catch (error) {
    result.files = [];
    if (error instanceof ImportFailure || error instanceof VerifiedQueryFailure) {
      addDiagnostic(
        result,
        error.code,
        'error',
        error.diagnosticPath,
        error.objectReference,
        error.message,
        error.remedy
      );
    } else {
      addDiagnostic(
        result,
        'invalid_ossie_document',
        'error',
        'input',
        ref('input'),
        errorMessage(error),
        'Correct the input and retry the conversion.'
      );
    }
    return result;
  }
  const paths = new Set<string>();
  for (const item of result.files) {
    if (paths.has(item.path)) {
      result.files = [];
      addDiagnostic(
        result,
        'output_path_conflict',
        'error',
        item.path,
        { documentPath: 'input', targetPath: item.path },
        `More than one generated file uses ${item.path}.`,
        'Remove the duplicate native identity.'
      );
      return result;
    }
    paths.add(item.path);
  }
  result.files.sort((left, right) => left.path.localeCompare(right.path));
  result.ok = true;
  const errors = result.diagnostics.some((entry) => entry.severity === 'error');
  const strictWarnings = Boolean(request.options?.strict) && result.diagnostics.length > 0;
  result.ready = !errors && !strictWarnings;
  return result;
}

/** Compatibility wrapper for callers that already parsed one Ossie document. */
export function importOssieDocument(input: unknown, options: ImportOssieOptions): ConversionResult {
  return importOssieDocuments({
    documents: [{ path: options.sourcePath, content: JSON.stringify(input) }],
    context: options.connections
      ? { connections: { connectionAliases: options.connections } }
      : undefined,
  });
}
