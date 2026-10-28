import {
  buildFqName,
  createOrReplaceTableAs,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { FieldMetadata } from '@bobsled-inc/protocol';
import type { ResolvedResolutionSpec, SqlStatement } from '../identity/types.js';
import { nullOfType, nullString } from '../identity/sql.js';
import { generateAuditLogDdl, ENTITY_GRAPH_SCHEMA } from '../audit/codegen.js';
import { outputTableName } from '../output-tables/index.js';
import { buildEntitySchemaCatalogMetadata } from './field-metadata.js';
import { generateObjectTypesSql } from '../object/codegen.js';
import type { ResolvedObjectSpec } from '../object/types.js';
import type { ResolvedEntityRelationshipSpec } from '../relationship/types.js';

export interface EntityGraphFoundationOptions {
  targetSchema: string;
  contractSchema?: string;
  namespace: string;
  relationshipSpecs?: readonly ResolvedEntityRelationshipSpec[];
  objectSpecs?: readonly ResolvedObjectSpec[];
}

interface UnionViewSpec {
  name: string;
  suffix: string;
  columns: string[];
}

const UNION_VIEWS: UnionViewSpec[] = [
  {
    name: 'entity_profiles',
    suffix: '__entity_profile',
    columns: [
      'entity_id',
      'cluster_id',
      'canonical_name',
      'display_name',
      'profile_attrs',
      'confidence',
      'freshness_age_seconds',
      'source_diversity',
      'profile_coverage',
      'last_seen_at',
      'lineage_run_id',
      'version',
    ],
  },
  {
    name: 'entity_quality_current',
    suffix: '__entity_quality',
    columns: [
      'entity_id',
      'cluster_id',
      'identity_confidence',
      'freshness_score',
      'source_diversity_score',
      'profile_attribute_coverage',
      'entity_trust_score',
      'trust_tier',
      'scored_at',
    ],
  },
  {
    name: 'crosswalks',
    suffix: '__crosswalks',
    columns: [
      'record_id',
      'source_ref',
      'source_pk_json',
      'source_system',
      'source_entity_id',
      'entity_id',
      'cluster_id',
      'component_id',
      'confidence_score',
      'matched_at',
    ],
  },
  {
    name: 'clusters',
    suffix: '__clusters',
    columns: [
      'entity_id',
      'cluster_id',
      'component_id',
      'record_id',
      'source_ref',
      'source_pk_json',
      'source_entity_id',
      'source_system',
      'confidence_score',
      'clustered_at',
    ],
  },
];

const RELATIONSHIP_UNION_VIEWS: UnionViewSpec[] = [
  {
    name: 'relationship_edges',
    suffix: '__relationship_edges',
    columns: [
      'edge_id',
      'relation_name',
      'left_entity_type',
      'left_entity_id',
      'right_entity_type',
      'right_entity_id',
      'confidence',
      'status',
      'valid_from',
      'valid_to',
      'decided_at',
    ],
  },
  {
    name: 'relationship_evidence',
    suffix: '__relationship_evidence',
    columns: [
      'edge_id',
      'relation_name',
      'evidence_type',
      'evidence_json',
      'score',
      'evaluated_at',
    ],
  },
];

function createViewSql(viewName: string, selectSql: string): string {
  return [`CREATE OR REPLACE VIEW ${viewName} AS`, selectSql].join('\n');
}

function entityType(spec: ResolvedResolutionSpec, namespace: string): string {
  return `${namespace}.${spec.entity}`;
}

function sourceSchema(spec: ResolvedResolutionSpec, fallbackSchema: string): string {
  return spec.targetSchema ?? fallbackSchema;
}

function buildUnionViewStatement(
  view: UnionViewSpec,
  specs: ResolvedResolutionSpec[],
  dialect: SupportedDialect,
  options: EntityGraphFoundationOptions
): SqlStatement {
  const viewName = buildFqName(options.contractSchema ?? ENTITY_GRAPH_SCHEMA, view.name, dialect);
  const selects = specs.map((spec) => {
    const tableName = buildFqName(
      sourceSchema(spec, options.targetSchema),
      outputTableName(spec.entity, view.suffix),
      dialect
    );
    const columns = [
      `${quoteLiteral(entityType(spec, options.namespace), dialect)} AS ${quoteIdentifier('entity_type', dialect)}`,
      ...view.columns.map((column) => quoteIdentifier(column, dialect)),
    ];
    return [
      `SELECT`,
      ...columns.map((column, index) => `  ${column}${index === columns.length - 1 ? '' : ','}`),
      `FROM ${tableName}`,
    ].join('\n');
  });

  return {
    name: `entity_graph_${view.name}`,
    sql: createViewSql(viewName, selects.join('\nUNION ALL\n')),
    tableCreated: `${options.contractSchema ?? ENTITY_GRAPH_SCHEMA}.${view.name}`,
  };
}

function relationSourceSchema(
  spec: ResolvedEntityRelationshipSpec,
  fallbackSchema: string
): string {
  return spec.targetSchema ?? fallbackSchema;
}

function relationshipType(spec: ResolvedEntityRelationshipSpec, namespace: string): string {
  return `${namespace}.${spec.name}`;
}

function typedEmptySelect(columns: string[], dialect: SupportedDialect): string {
  return [
    `SELECT`,
    ...columns.map((column, index) => {
      const comma = index === columns.length - 1 ? '' : ',';
      return `  ${nullString(dialect)} AS ${quoteIdentifier(column, dialect)}${comma}`;
    }),
    `WHERE 1 = 0`,
  ].join('\n');
}

function buildRelationshipUnionViewStatement(
  view: UnionViewSpec,
  specs: readonly ResolvedEntityRelationshipSpec[],
  dialect: SupportedDialect,
  options: EntityGraphFoundationOptions
): SqlStatement {
  const viewName = buildFqName(options.contractSchema ?? ENTITY_GRAPH_SCHEMA, view.name, dialect);
  const columns = ['relationship_type', ...view.columns];
  const selects = specs.map((spec) => {
    const tableName = buildFqName(
      relationSourceSchema(spec, options.targetSchema),
      outputTableName(spec.name, view.suffix),
      dialect
    );
    const selectColumns = [
      `${quoteLiteral(relationshipType(spec, options.namespace), dialect)} AS ${quoteIdentifier('relationship_type', dialect)}`,
      ...view.columns.map((column) => quoteIdentifier(column, dialect)),
    ];
    return [
      `SELECT`,
      ...selectColumns.map((column, index) =>
        index === selectColumns.length - 1 ? `  ${column}` : `  ${column},`
      ),
      `FROM ${tableName}`,
    ].join('\n');
  });
  return {
    name: `entity_graph_${view.name}`,
    sql: createViewSql(
      viewName,
      selects.length > 0 ? selects.join('\nUNION ALL\n') : typedEmptySelect(columns, dialect)
    ),
    tableCreated: `${options.contractSchema ?? ENTITY_GRAPH_SCHEMA}.${view.name}`,
  };
}

// Relationship quality is an occasional monitoring view; this is O(specs × 3 table scans).
// Pre-aggregate counts or join aggregated tables if callers need low-latency production use.
export function generateRelationshipQualitySql(
  specs: readonly ResolvedEntityRelationshipSpec[],
  dialect: SupportedDialect,
  options: EntityGraphFoundationOptions
): SqlStatement {
  const viewName = buildFqName(
    options.contractSchema ?? ENTITY_GRAPH_SCHEMA,
    'relationship_quality',
    dialect
  );
  const rows = specs.map((spec) => {
    const schema = relationSourceSchema(spec, options.targetSchema);
    const candidates = buildFqName(
      schema,
      outputTableName(spec.name, '__relationship_candidates'),
      dialect
    );
    const edges = buildFqName(schema, outputTableName(spec.name, '__relationship_edges'), dialect);
    const review = buildFqName(
      schema,
      outputTableName(spec.name, '__relationship_review_queue'),
      dialect
    );
    return [
      `SELECT`,
      `  ${quoteLiteral(relationshipType(spec, options.namespace), dialect)} AS ${quoteIdentifier('relationship_type', dialect)},`,
      `  ${quoteLiteral(spec.leftEntity, dialect)} AS ${quoteIdentifier('left_entity', dialect)},`,
      `  ${quoteLiteral(spec.rightEntity, dialect)} AS ${quoteIdentifier('right_entity', dialect)},`,
      `  (SELECT COUNT(*) FROM ${candidates}) AS ${quoteIdentifier('candidate_count', dialect)},`,
      `  (SELECT COUNT(*) FROM ${edges}) AS ${quoteIdentifier('edge_count', dialect)},`,
      `  (SELECT COUNT(*) FROM ${review}) AS ${quoteIdentifier('review_count', dialect)},`,
      `  ${quoteLiteral(spec.relationshipType, dialect)} AS ${quoteIdentifier('relationship_type_cardinality', dialect)}`,
    ].join('\n');
  });
  const empty = [
    `SELECT`,
    `  ${nullString(dialect)} AS ${quoteIdentifier('relationship_type', dialect)},`,
    `  ${nullString(dialect)} AS ${quoteIdentifier('left_entity', dialect)},`,
    `  ${nullString(dialect)} AS ${quoteIdentifier('right_entity', dialect)},`,
    `  CAST(0 AS INTEGER) AS ${quoteIdentifier('candidate_count', dialect)},`,
    `  CAST(0 AS INTEGER) AS ${quoteIdentifier('edge_count', dialect)},`,
    `  CAST(0 AS INTEGER) AS ${quoteIdentifier('review_count', dialect)},`,
    `  ${nullString(dialect)} AS ${quoteIdentifier('relationship_type_cardinality', dialect)}`,
    `WHERE 1 = 0`,
  ].join('\n');

  return {
    name: 'entity_graph_relationship_quality',
    sql: createViewSql(viewName, rows.length > 0 ? rows.join('\nUNION ALL\n') : empty),
    tableCreated: `${options.contractSchema ?? ENTITY_GRAPH_SCHEMA}.relationship_quality`,
  };
}

function catalogMetadataExpr(metadata: FieldMetadata, dialect: SupportedDialect): string {
  const json = quoteLiteral(JSON.stringify(metadata), dialect);
  switch (dialect) {
    case 'snowflake':
    case 'bigquery':
      return `PARSE_JSON(${json})`;
    case 'postgres':
    case 'pgvector':
      return `CAST(${json} AS JSONB)`;
    case 'redshift':
      return `JSON_PARSE(${json})`;
    case 'duckdb':
      return `CAST(${json} AS JSON)`;
    case 'databricks':
    case 'clickhouse':
      return json;
    case 'mysql':
      return `JSON_EXTRACT(${json}, '$')`;
  }
}

function catalogMetadataType(dialect: SupportedDialect): string {
  switch (dialect) {
    case 'snowflake':
      return 'VARIANT';
    case 'postgres':
    case 'pgvector':
      return 'JSONB';
    case 'redshift':
      return 'SUPER';
    case 'databricks':
      return 'STRING';
    // ClickHouse's JSON column type is still young, so the catalog metadata
    // rides as a plain String like the Databricks branch above.
    case 'clickhouse':
      return 'String';
    case 'bigquery':
    case 'duckdb':
    case 'mysql':
      return 'JSON';
  }
}

export function generateEntitySchemaCatalogSql(
  specs: ResolvedResolutionSpec[],
  dialect: SupportedDialect,
  options: EntityGraphFoundationOptions
): SqlStatement {
  const tableName = buildFqName(
    options.contractSchema ?? ENTITY_GRAPH_SCHEMA,
    'entity_schema_catalog',
    dialect
  );
  const rows = specs.flatMap((spec) =>
    buildEntitySchemaCatalogMetadata(spec, entityType(spec, options.namespace)).map((entry) => {
      const namespacedEntity = entityType(spec, options.namespace);
      const columns = [
        `${quoteLiteral(namespacedEntity, dialect)} AS ${quoteIdentifier('entity_type', dialect)}`,
        `${quoteLiteral(entry.attribute, dialect)} AS ${quoteIdentifier('attribute', dialect)}`,
        `${catalogMetadataExpr(entry.fieldMetadata, dialect)} AS ${quoteIdentifier('field_metadata', dialect)}`,
      ];
      return [
        `SELECT`,
        ...columns.map((column, index) => `  ${column}${index === columns.length - 1 ? '' : ','}`),
      ].join('\n');
    })
  );

  // Fall back to a typed empty SELECT so the resulting CREATE TABLE AS stays valid even when
  // no specs contribute catalog attributes (fresh project, all profiles disabled, etc.).
  const selectSql =
    rows.length > 0
      ? rows.join('\nUNION ALL\n')
      : [
          `SELECT`,
          `  ${nullString(dialect)} AS ${quoteIdentifier('entity_type', dialect)},`,
          `  ${nullString(dialect)} AS ${quoteIdentifier('attribute', dialect)},`,
          `  ${nullOfType(catalogMetadataType(dialect), dialect)} AS ${quoteIdentifier('field_metadata', dialect)}`,
          `WHERE 1 = 0`,
        ].join('\n');

  return {
    name: 'entity_graph_entity_schema_catalog',
    sql: [createOrReplaceTableAs(tableName, dialect), selectSql].join('\n'),
    tableCreated: `${options.contractSchema ?? ENTITY_GRAPH_SCHEMA}.entity_schema_catalog`,
  };
}

export function generateEntityGraphUnionSql(
  specs: ResolvedResolutionSpec[],
  dialect: SupportedDialect,
  options: EntityGraphFoundationOptions
): SqlStatement[] {
  const relationshipSpecs = options.relationshipSpecs ?? [];
  const objectSpecs = options.objectSpecs ?? [];
  return [
    ...UNION_VIEWS.map((view) => buildUnionViewStatement(view, specs, dialect, options)),
    ...RELATIONSHIP_UNION_VIEWS.map((view) =>
      buildRelationshipUnionViewStatement(view, relationshipSpecs, dialect, options)
    ),
    generateRelationshipQualitySql(relationshipSpecs, dialect, options),
    generateEntitySchemaCatalogSql(specs, dialect, options),
    generateObjectTypesSql(objectSpecs, dialect, { contractSchema: options.contractSchema }),
  ];
}

export function compileEntityGraphFoundation(
  specs: ResolvedResolutionSpec[],
  dialect: SupportedDialect,
  options: EntityGraphFoundationOptions
): SqlStatement[] {
  return [
    ...generateAuditLogDdl(dialect, options.contractSchema),
    ...generateEntityGraphUnionSql(specs, dialect, options),
  ];
}
