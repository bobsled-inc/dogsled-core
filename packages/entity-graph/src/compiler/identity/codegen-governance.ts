import {
  buildFqName,
  emitSha256Expr,
  quoteIdentifier,
  quoteLiteral,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import type {
  ProfileAttributeMasking,
  ResolvedPiiControl,
  ResolvedProfileAttribute,
  ResolvedResolutionSpec,
  SqlStatement,
} from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { nullOfType } from './sql.js';
import { sourceTail } from './codegen-golden.js';
import { resolveEffectiveProfileConfig } from './profile-config.js';

export interface GovernanceArtifact {
  name: string;
  format: 'sql' | 'json';
  content: string;
}

export interface GovernanceGuidanceManifest {
  entity: string;
  dialect: SupportedDialect;
  masked_view: string;
  columns: Array<{
    column: string;
    masking: ProfileAttributeMasking;
    classification: string;
  }>;
}

interface MaskedAttribute {
  attribute: ResolvedProfileAttribute;
  control: ResolvedPiiControl;
}

function createOrReplaceViewAs(fqName: string): string {
  return `CREATE OR REPLACE VIEW ${fqName} AS`;
}

function stringExpr(expr: string, dialect: SupportedDialect): string {
  switch (dialect) {
    case 'bigquery':
    case 'databricks':
      return `CAST(${expr} AS STRING)`;
    case 'mysql':
      return `CAST(${expr} AS CHAR)`;
    case 'postgres':
    case 'pgvector':
      return `CAST(${expr} AS TEXT)`;
    default:
      return `CAST(${expr} AS VARCHAR)`;
  }
}

function stringType(dialect: SupportedDialect): string {
  switch (dialect) {
    case 'bigquery':
    case 'databricks':
      return 'STRING';
    case 'postgres':
    case 'pgvector':
      return 'TEXT';
    case 'mysql':
      return 'CHAR';
    default:
      return 'VARCHAR';
  }
}

function sha256Expr(expr: string, dialect: SupportedDialect): string {
  return emitSha256Expr(expr, dialect);
}

function concatExpr(parts: string[]): string {
  return `CONCAT(${parts.join(', ')})`;
}

function leftExpr(expr: string, chars: number, dialect: SupportedDialect): string {
  switch (dialect) {
    case 'postgres':
    case 'pgvector':
    case 'redshift':
    case 'mysql':
      return `LEFT(${expr}, ${chars})`;
    default:
      return `SUBSTR(${expr}, 1, ${chars})`;
  }
}

function rightExpr(expr: string, chars: number, dialect: SupportedDialect): string {
  switch (dialect) {
    case 'postgres':
    case 'pgvector':
    case 'redshift':
    case 'mysql':
      return `RIGHT(${expr}, ${chars})`;
    default:
      return `SUBSTR(${expr}, -${chars})`;
  }
}

function lengthExpr(expr: string): string {
  return `LENGTH(${expr})`;
}

function maskExpression(
  sourceExpr: string,
  masking: ProfileAttributeMasking,
  dialect: SupportedDialect
): string {
  switch (masking) {
    case 'none':
      return sourceExpr;
    case 'hash':
      return `CASE WHEN ${sourceExpr} IS NULL THEN NULL ELSE ${sha256Expr(sourceExpr, dialect)} END`;
    case 'partial': {
      const text = stringExpr(sourceExpr, dialect);
      return [
        `CASE`,
        `  WHEN ${sourceExpr} IS NULL THEN NULL`,
        `  WHEN ${lengthExpr(text)} <= 4 THEN ${quoteLiteral('****', dialect)}`,
        `  ELSE ${concatExpr([
          leftExpr(text, 2, dialect),
          quoteLiteral('***', dialect),
          rightExpr(text, 2, dialect),
        ])}`,
        `END`,
      ].join(' ');
    }
    case 'null':
      // Local stringType, not the shared one: this module's mapping differs for
      // duckdb and redshift and its output is snapshot-pinned.
      return nullOfType(stringType(dialect), dialect);
  }
}

function controlsForProfile(spec: ResolvedResolutionSpec): MaskedAttribute[] {
  const profile = resolveEffectiveProfileConfig(spec);
  const controls = new Map<string, ResolvedPiiControl>();
  for (const control of profile.piiControls?.attributes ?? []) {
    controls.set(control.field, control);
  }
  return profile.attributes.flatMap((attribute) => {
    const control = controls.get(attribute.alias) ?? controls.get(attribute.field);
    return control ? [{ attribute, control }] : [];
  });
}

function allProfileAttributes(spec: ResolvedResolutionSpec): ResolvedProfileAttribute[] {
  return resolveEffectiveProfileConfig(spec).attributes;
}

function sourceColumns(
  spec: ResolvedResolutionSpec
): Array<{ idColumn: string; hasColumn: string }> {
  return spec.inputs.map((input) => {
    const tail = sourceTail(input.ref);
    return { idColumn: `${tail}_id`, hasColumn: `has_${tail}` };
  });
}

export function generateMaskedGoldenViewSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): SqlStatement | undefined {
  const masked = controlsForProfile(spec);
  if (masked.length === 0) return undefined;

  const entity = spec.entity;
  const golden = buildFqName(targetSchema, outputTableName(entity, '__golden'), dialect);
  const maskedGolden = buildFqName(
    targetSchema,
    outputTableName(entity, '__golden_masked'),
    dialect
  );
  const controlByAlias = new Map(
    masked.map(({ attribute, control }) => [attribute.alias, control])
  );
  const sourceAlias = quoteIdentifier('g', dialect);

  const attributeSelections = allProfileAttributes(spec).map((attribute) => {
    const quoted = quoteIdentifier(attribute.alias, dialect);
    const sourceExpr = `${sourceAlias}.${quoted}`;
    const control = controlByAlias.get(attribute.alias);
    const expr = control ? maskExpression(sourceExpr, control.masking, dialect) : sourceExpr;
    return `  ${expr} AS ${quoted}`;
  });

  const selections = [
    `  ${sourceAlias}.${quoteIdentifier('entity_id', dialect)}`,
    ...attributeSelections,
    ...sourceColumns(spec).flatMap((source) => {
      // Per-source natural keys (`<tail>_id`) are frequently the source PK,
      // which is often itself PII (an email/phone used as the join key). A view
      // whose whole purpose is masking must not leak them verbatim, so hash them
      // by default; the `has_<tail>` presence booleans stay unmasked.
      const idColumn = quoteIdentifier(source.idColumn, dialect);
      const maskedId = maskExpression(`${sourceAlias}.${idColumn}`, 'hash', dialect);
      return [
        `  ${maskedId} AS ${idColumn}`,
        `  ${sourceAlias}.${quoteIdentifier(source.hasColumn, dialect)}`,
      ];
    }),
    `  ${sourceAlias}.${quoteIdentifier('cluster_size', dialect)}`,
    `  ${sourceAlias}.${quoteIdentifier('trust_score', dialect)}`,
    `  ${sourceAlias}.${quoteIdentifier('trust_band', dialect)}`,
  ];

  return {
    name: 'golden_masked',
    sql: [
      createOrReplaceViewAs(maskedGolden),
      `SELECT`,
      selections.join(',\n'),
      `FROM ${golden} AS ${sourceAlias}`,
    ].join('\n'),
    tableCreated: outputTableName(entity, '__golden_masked'),
  };
}

export function generateSnowflakeGovernanceDdl(
  spec: ResolvedResolutionSpec,
  targetSchema: string
): string {
  const masked = controlsForProfile(spec);
  if (masked.length === 0) return '';
  const tagName = buildFqName(targetSchema, `${spec.entity}__pii_classification`, 'snowflake');
  const maskedView = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__golden_masked'),
    'snowflake'
  );
  const lines = [
    `CREATE TAG IF NOT EXISTS ${tagName};`,
    `CREATE MASKING POLICY IF NOT EXISTS ${buildFqName(
      targetSchema,
      `${spec.entity}__pii_mask_string`,
      'snowflake'
    )} AS (val STRING) RETURNS STRING ->`,
    `  CASE WHEN CURRENT_ROLE() IN (${[
      quoteLiteral('ACCOUNTADMIN', 'snowflake'),
      quoteLiteral('SECURITYADMIN', 'snowflake'),
    ].join(', ')}) THEN val ELSE ${quoteLiteral('***MASKED***', 'snowflake')} END;`,
  ];
  for (const { attribute, control } of masked) {
    const column = quoteIdentifier(attribute.alias, 'snowflake');
    lines.push(
      `ALTER VIEW ${maskedView} MODIFY COLUMN ${column} SET TAG ${tagName} = ${quoteLiteral(
        control.classification ?? 'pii',
        'snowflake'
      )};`,
      `ALTER VIEW ${maskedView} MODIFY COLUMN ${column} SET MASKING POLICY ${buildFqName(
        targetSchema,
        `${spec.entity}__pii_mask_string`,
        'snowflake'
      )};`
    );
  }
  return lines.join('\n');
}

export function generateGovernanceGuidanceManifest(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): GovernanceGuidanceManifest {
  return {
    entity: spec.entity,
    dialect,
    masked_view: buildFqName(
      targetSchema,
      outputTableName(spec.entity, '__golden_masked'),
      dialect
    ),
    columns: controlsForProfile(spec).map(({ attribute, control }) => ({
      column: attribute.alias,
      masking: control.masking,
      classification: control.classification ?? 'pii',
    })),
  };
}

export function generateGovernanceArtifacts(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): GovernanceArtifact[] {
  const masked = controlsForProfile(spec);
  if (masked.length === 0) return [];
  if (dialect === 'snowflake') {
    return [
      {
        name: 'governance_snowflake',
        format: 'sql',
        content: generateSnowflakeGovernanceDdl(spec, targetSchema),
      },
    ];
  }
  if (dialect === 'bigquery' || dialect === 'databricks') {
    return [
      {
        name: 'governance_guidance',
        format: 'json',
        content: JSON.stringify(
          generateGovernanceGuidanceManifest(spec, dialect, targetSchema),
          null,
          2
        ),
      },
    ];
  }
  return [];
}
