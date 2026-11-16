import { z } from 'zod';
import { FieldMetadataSchema } from '@bobsled-inc/protocol';

import { SourceSpecSchema, TransformSpecSchema } from '../compiler/schemas.js';
import { MetricSpecSchema } from '../entities/metric.js';
import { RelationshipSpecSchema } from '../entities/relationship.js';
import { aiContextSynonyms, mergeSynonyms } from '../entities/semantic-metadata.js';
import { CommandError } from '../errors.js';
import { tryParseExpr } from '../compiler/expr/parser.js';
import { walkExpr } from '../compiler/expr/walker.js';
import {
  bobsledExtension,
  validateOssieDocument,
  type OssieDataset,
  type OssieField,
} from './schema.js';
import { logicalTypeForSqlType } from './types.js';
import { currentOssieUri, isOssieLocalUri } from '../interchange/common.js';

export interface OssieOrigin {
  filePath: string;
  datasetIndex: number;
  name: string;
  kind: 'source' | 'derived';
  source: string;
  document: unknown;
}
export interface TranslatedOssieEntry {
  kind: 'source' | 'model' | 'metric' | 'relationship';
  document: unknown;
}
export interface TranslatedOssieDocument {
  entries: TranslatedOssieEntry[];
  origins: OssieOrigin[];
}
const forbiddenBuild = new Set([
  'name',
  'type',
  'spec_version',
  'description',
  'grain',
  'columns',
  'model_kind',
  'derived_columns',
  'interchange',
]);
const fieldMetadata = FieldMetadataSchema.omit({
  name: true,
  type: true,
  description: true,
}).strict();
export const fieldExtensionSchema = fieldMetadata.extend({
  build_expression: z.string().min(1).optional(),
  sql_type: z.string().min(1).optional(),
  dimension: z.number().int().positive().optional(),
  not_null: z.boolean().optional(),
});

function synonymsProperty(...lists: readonly unknown[]): { synonyms?: string[] } {
  const synonyms = mergeSynonyms(...lists);
  return synonyms.length ? { synonyms } : {};
}
function fail(where: string, message: string): never {
  throw new CommandError(`${where}: ${message}`, 2);
}
function parse<T>(schema: z.ZodType<T>, data: unknown, where: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    fail(where, result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}
function onlyKeys(data: Record<string, unknown>, keys: Set<string>, where: string): void {
  for (const key of Object.keys(data)) {
    if (!keys.has(key)) fail(where, `Unsupported BOBSLED property ${key}`);
  }
}
/** Native schemas sometimes strip unknown keys. Extensions must not silently lose settings. */
export function assertNoDiscardedKeys(input: unknown, output: unknown, where: string): void {
  if (!input || typeof input !== 'object' || !output || typeof output !== 'object') return;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(output, key)) fail(where, `Unsupported BOBSLED property ${key}`);
    assertNoDiscardedKeys(Reflect.get(input, key), Reflect.get(output, key), `${where}.${key}`);
  }
}
function fieldsFor(
  dataset: OssieDataset,
  derived: boolean,
  where: string,
  vendor: string
): Record<string, unknown>[] {
  if (!dataset.fields?.length) {
    fail(where, 'Bobsled Core requires an explicit, non-empty fields list');
  }
  const names = new Set<string>();
  const columns = dataset.fields.map((field) => {
    const key = field.name.toLowerCase();
    if (names.has(key)) fail(where, `Duplicate field ${field.name}`);
    names.add(key);
    return fieldFor(
      field,
      derived,
      dataset.primary_key ?? [],
      `${where}.fields.${field.name}`,
      vendor
    );
  });
  for (const key of [...(dataset.primary_key ?? []), ...(dataset.unique_keys ?? []).flat()]) {
    if (!dataset.fields.some((field) => field.name === key)) {
      fail(where, `Key references unknown field ${key}`);
    }
  }
  return columns;
}
function fieldFor(
  field: OssieField,
  derived: boolean,
  keys: string[],
  where: string,
  vendor: string
): Record<string, unknown> {
  const extension = parse(
    fieldExtensionSchema,
    bobsledExtension(field, where, false, vendor),
    where
  );
  const { build_expression, sql_type, ...metadata } = extension;
  if (sql_type && field.datatype && logicalTypeForSqlType(sql_type) !== field.datatype) {
    fail(where, `sql_type ${sql_type} conflicts with datatype ${field.datatype}`);
  }
  if (!derived && !sql_type) {
    fail(
      where,
      'Source fields require BOBSLED sql_type; logical types do not specify physical precision'
    );
  }
  if (derived && !build_expression) fail(where, 'Derived fields require BOBSLED build_expression');
  if (!derived && build_expression) fail(where, 'Source fields cannot have a build_expression');
  // A computed semantic field is not necessarily an output column. Until that
  // distinction is represented, fail rather than compile a misleading schema.
  for (const expr of field.expression.dialects) {
    const text = expr.expression.trim();
    const escaped = field.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^(?:${escaped}|"${escaped}"|\x60${escaped}\x60)$`).test(text)) {
      fail(
        where,
        'Bobsled Core output fields must read their finished column; put build formulas in BOBSLED build_expression'
      );
    }
  }
  return {
    ...metadata,
    name: field.name,
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...synonymsProperty(aiContextSynonyms(field.ai_context)),
    ...(sql_type ? { type: sql_type } : {}),
    ...(derived
      ? { expr: build_expression, ...(keys.includes(field.name) ? { primary_key: true } : {}) }
      : {}),
  };
}

export function translateOssieDocument(
  document: unknown,
  filePath: string,
  vendor = 'BOBSLED'
): TranslatedOssieDocument {
  const doc = validateOssieDocument(document, filePath);
  if (Object.keys(bobsledExtension(doc, filePath, false, vendor)).length) {
    fail(
      filePath,
      'Document-level BOBSLED execution settings are unsupported; use dataset extensions'
    );
  }
  const entries: TranslatedOssieEntry[] = [];
  const origins: OssieOrigin[] = [];
  const datasets = new Map<string, OssieDataset>();
  const derivedNames = new Set<string>();
  for (const [datasetIndex, dataset] of doc.datasets.entries()) {
    const where = `${filePath}#datasets[${datasetIndex}] (${dataset.name})`;
    if ([...datasets.keys()].some((n) => n.toLowerCase() === dataset.name.toLowerCase())) {
      fail(where, 'Duplicate dataset name');
    }
    datasets.set(dataset.name, dataset);
    const extension = bobsledExtension(dataset, where, true, vendor);
    if (extension['extension_version'] !== '1') {
      fail(where, 'Unsupported BOBSLED extension_version; expected "1"');
    }
    const kind = extension['kind'];
    if (kind !== 'source' && kind !== 'derived') {
      fail(where, 'BOBSLED kind must be source or derived (agentic is unsupported)');
    }
    const columns = fieldsFor(dataset, kind === 'derived', where, vendor);
    let native: unknown;
    if (kind === 'derived') {
      onlyKeys(extension, new Set(['extension_version', 'kind', 'grain', 'build']), where);
      const build = parse(z.record(z.string(), z.unknown()), extension['build'], `${where}.build`);
      for (const key of Object.keys(build)) {
        if (forbiddenBuild.has(key)) {
          fail(
            where,
            `build.${key} belongs in standard fields or its dedicated extension property`
          );
        }
      }
      if (build['include_all_columns'] === true) {
        fail(where, 'include_all_columns is unsupported; list every output field explicitly');
      }
      for (const key of ['pivot', 'unpivot', 'flatten_json', 'hierarchy', 'recurse']) {
        if (build[key] !== undefined) {
          fail(
            where,
            `build.${key} needs an explicit final-output field mapping and is not supported yet`
          );
        }
      }
      const raw = {
        ...build,
        spec_version: '0.2',
        type: 'model',
        name: dataset.name,
        description: dataset.description,
        ...synonymsProperty(build['synonyms'], aiContextSynonyms(dataset.ai_context)),
        grain: extension['grain'],
        columns,
      };
      native = parse(TransformSpecSchema, raw, where);
      assertNoDiscardedKeys(raw, native, where);
      derivedNames.add(dataset.name);
      const materialization = (native as z.infer<typeof TransformSpecSchema>).materialization.type;
      if (isOssieLocalUri(dataset.source)) {
        if (currentOssieUri(dataset.source) !== `bobsled://models/${dataset.name}`) {
          fail(where, 'Project-local source must be bobsled://models/<dataset-name>');
        }
        // Live closures are validated by the existing runtime. Persisted outputs
        // cannot substitute a local reference for their actual warehouse address.
        if (
          ['table', 'incremental', 'snapshot', 'dynamic_table', 'materialized_view'].includes(
            materialization
          )
        ) {
          fail(where, 'Persisted models require a warehouse source address');
        }
      } else if (materialization === 'ephemeral') {
        fail(where, 'Ephemeral models require bobsled://models/<dataset-name>');
      }
    } else {
      const { extension_version: _version, kind: _kind, ...settings } = extension;
      if (
        Object.hasOwn(settings, 'name') ||
        Object.hasOwn(settings, 'description') ||
        Object.hasOwn(settings, 'schema') ||
        Object.hasOwn(settings, 'table') ||
        Object.hasOwn(settings, 'type') ||
        Object.hasOwn(settings, 'spec_version')
      ) {
        fail(
          where,
          'Source identity, description, fields, and table belong in standard Ossie properties'
        );
      }
      const sourceType = settings['source_type'] ?? 'warehouse_table';
      const raw = {
        ...settings,
        source_type: sourceType,
        spec_version: '0.2',
        type: 'source',
        name: dataset.name,
        description: dataset.description,
        ...synonymsProperty(settings['synonyms'], aiContextSynonyms(dataset.ai_context)),
        schema: { columns },
        ...(sourceType === 'warehouse_table' ? { table: dataset.source } : {}),
      };
      native = parse(SourceSpecSchema, raw, where);
      assertNoDiscardedKeys(raw, native, where);
      if (
        sourceType === 'api_resource' &&
        currentOssieUri(dataset.source) !==
          `bobsled://sources/${String(settings['connection'])}/${dataset.name}`
      ) {
        fail(where, 'API sources require bobsled://sources/<connection>/<dataset-name>');
      }
    }
    origins.push({
      filePath,
      datasetIndex,
      name: dataset.name,
      kind,
      source: dataset.source,
      document,
    });
    entries.push({ kind: kind === 'derived' ? 'model' : 'source', document: native });
  }
  for (const metric of doc.metrics ?? []) {
    const where = `${filePath}#metrics.${metric.name}`;
    const extension = bobsledExtension(metric, where, false, vendor);
    onlyKeys(extension, new Set(['tags']), where);
    const expressions = metric.expression.dialects;
    const ansi = expressions.find((e) => e.dialect === 'ANSI_SQL');
    if (!ansi) {
      fail(
        where,
        'Bobsled Core metric mapping requires an ANSI_SQL expression; other alternatives remain in the authored document'
      );
    }
    const parsedExpression = tryParseExpr(ansi.expression);
    if (!parsedExpression.ok) fail(where, 'Unsupported metric expression syntax');
    const models = new Set<string>();
    walkExpr(parsedExpression.expr, (node) => {
      if (['raw_sql', 'subquery', 'exists', 'in_subquery'].includes(node.kind)) {
        fail(where, 'Metric subqueries and raw SQL are not supported by this mapping');
      }
      if (node.kind !== 'column_ref') return;
      if (
        !node.table ||
        !derivedNames.has(node.table) ||
        !datasets.get(node.table)?.fields?.some((field) => field.name === node.column)
      ) {
        fail(
          where,
          `Unsupported or unknown metric field ${node.table ?? '(unqualified)'}.${node.column}`
        );
      }
      models.add(node.table);
    });
    if (!models.size) fail(where, 'Metric expression must explicitly reference dataset.field');
    entries.push({
      kind: 'metric',
      document: parse(
        MetricSpecSchema,
        {
          spec_version: '0.2',
          type: 'metric',
          name: metric.name,
          description: metric.description,
          models: [...models],
          expression: ansi.expression,
          ...extension,
          ...synonymsProperty(extension['synonyms'], aiContextSynonyms(metric.ai_context)),
        },
        where
      ),
    });
  }
  for (const relationship of doc.relationships ?? []) {
    const where = `${filePath}#relationships.${relationship.name}`;
    const extension = bobsledExtension(relationship, where, false, vendor);
    onlyKeys(extension, new Set(['join_type', 'description', 'tags']), where);
    if (!derivedNames.has(relationship.from) || !derivedNames.has(relationship.to)) {
      fail(where, 'Bobsled Core relationships require derived datasets in this document');
    }
    if (relationship.from_columns.length !== relationship.to_columns.length) {
      fail(where, 'Relationship column arrays must have equal length');
    }
    for (const [name, columns] of [
      [relationship.from, relationship.from_columns],
      [relationship.to, relationship.to_columns],
    ] as const) {
      for (const column of columns) {
        if (!datasets.get(name)?.fields?.some((f) => f.name === column)) {
          fail(where, `Unknown relationship field ${name}.${column}`);
        }
      }
    }
    entries.push({
      kind: 'relationship',
      document: parse(
        RelationshipSpecSchema,
        {
          spec_version: '0.2',
          type: 'relationship',
          name: relationship.name,
          left_model: relationship.from,
          right_model: relationship.to,
          relationship_type: 'many_to_one',
          join_columns: relationship.from_columns.map((left, i) => ({
            left,
            right: relationship.to_columns[i],
          })),
          ...extension,
        },
        where
      ),
    });
  }
  return { entries, origins };
}
