import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type {
  ResolvedProfileAttribute,
  ResolvedResolutionSpec,
  ResolvedViewsConfig,
  SqlStatement,
} from './types.js';
import { outputTableName } from '../output-tables/index.js';
import { resolveEffectiveProfileConfig } from './profile-config.js';
import { buildSourceEntityIdExpr, jsonExtractString } from './sql.js';

export const DEFAULT_VIEW_NAME_PATTERN = '{source_table}_clean';
export const DEFAULT_INCLUDE_ENTITY_GRAPH_METADATA = true;
const ENTITY_GRAPH_ENTITY_ID_COLUMN = 'ENTITY_GRAPH_ENTITY_ID';
const ENTITY_GRAPH_CLUSTER_ID_COLUMN = 'ENTITY_GRAPH_CLUSTER_ID';
const ENTITY_GRAPH_COMPONENT_ID_COLUMN = 'ENTITY_GRAPH_COMPONENT_ID';
const ENTITY_GRAPH_CONFIDENCE_SCORE_COLUMN = 'ENTITY_GRAPH_CONFIDENCE_SCORE';
const RESERVED_ENTITY_GRAPH_METADATA_COLUMNS = [
  ENTITY_GRAPH_ENTITY_ID_COLUMN,
  ENTITY_GRAPH_CLUSTER_ID_COLUMN,
  ENTITY_GRAPH_COMPONENT_ID_COLUMN,
  ENTITY_GRAPH_CONFIDENCE_SCORE_COLUMN,
] as const;

interface EffectiveViewsConfig extends ResolvedViewsConfig {
  includeEntityGraphMetadata: boolean;
}

export function resolveEffectiveViewsConfig(
  spec: ResolvedResolutionSpec
): EffectiveViewsConfig | null {
  if (!spec.profile) {
    return null;
  }

  if (spec.profile.views?.enabled === false) {
    return null;
  }

  return {
    enabled: true,
    namePattern: spec.profile.views?.namePattern ?? DEFAULT_VIEW_NAME_PATTERN,
    includeEntityGraphMetadata:
      spec.profile.views?.includeEntityGraphMetadata ?? DEFAULT_INCLUDE_ENTITY_GRAPH_METADATA,
  };
}

function buildAttributeMap(
  attributes: ResolvedProfileAttribute[]
): ReadonlyMap<string, ResolvedProfileAttribute> {
  return new Map(attributes.map((attribute) => [attribute.field.toLowerCase(), attribute]));
}

function buildColumnSelections(
  sourceColumns: readonly string[],
  profileAttrsExpr: string,
  displayNameField: string | undefined,
  attributesByLowerField: ReadonlyMap<string, ResolvedProfileAttribute>,
  includeEntityGraphMetadata: boolean,
  dialect: SupportedDialect
): string[] {
  const columns: string[] = [];
  const displayNameLower = displayNameField?.toLowerCase();

  if (includeEntityGraphMetadata) {
    const reservedColumns = new Set(
      RESERVED_ENTITY_GRAPH_METADATA_COLUMNS.map((column) => column.toLowerCase())
    );
    const collisions = sourceColumns.filter((column) => reservedColumns.has(column.toLowerCase()));
    if (collisions.length > 0) {
      throw new Error(
        `Clean view source columns collide with reserved Entity Graph metadata columns: ${collisions.join(', ')}`
      );
    }
  }

  for (const column of sourceColumns) {
    const sourceColumn = `src.${quoteIdentifier(column, dialect)}`;
    const sourceAlias = quoteIdentifier(column, dialect);
    const columnLower = column.toLowerCase();

    if (displayNameLower !== undefined && columnLower === displayNameLower) {
      columns.push(
        `COALESCE(ep.${quoteIdentifier('display_name', dialect)}, ${sourceColumn}) AS ${sourceAlias}`
      );
      continue;
    }

    const attribute = attributesByLowerField.get(columnLower);
    if (attribute) {
      columns.push(
        `COALESCE(${jsonExtractString(profileAttrsExpr, attribute.alias, dialect)}, ${sourceColumn}) AS ${sourceAlias}`
      );
      continue;
    }

    columns.push(`${sourceColumn} AS ${sourceAlias}`);
  }

  if (includeEntityGraphMetadata) {
    columns.push(
      `cw.${quoteIdentifier('entity_id', dialect)} AS ${quoteIdentifier(
        ENTITY_GRAPH_ENTITY_ID_COLUMN,
        dialect
      )}`
    );
    columns.push(
      `cw.${quoteIdentifier('cluster_id', dialect)} AS ${quoteIdentifier(
        ENTITY_GRAPH_CLUSTER_ID_COLUMN,
        dialect
      )}`
    );
    columns.push(
      `cw.${quoteIdentifier('component_id', dialect)} AS ${quoteIdentifier(
        ENTITY_GRAPH_COMPONENT_ID_COLUMN,
        dialect
      )}`
    );
    columns.push(
      `cw.${quoteIdentifier('confidence_score', dialect)} AS ${quoteIdentifier(
        ENTITY_GRAPH_CONFIDENCE_SCORE_COLUMN,
        dialect
      )}`
    );
  }

  return columns;
}

export function resolveCleanViewName(ref: string, entity: string, pattern: string): string {
  const parts = ref.split('.');
  const sourceTable = parts[parts.length - 1] ?? ref;

  return pattern.replace(/\{source_table\}|\{entity\}/g, (match) =>
    match === '{entity}' ? entity : sourceTable
  );
}

export function generateCleanViewsSql(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): { statements: SqlStatement[]; warnings: string[] } {
  const viewConfig = resolveEffectiveViewsConfig(spec);
  if (!viewConfig) {
    return { statements: [], warnings: [] };
  }

  const warnings: string[] = [];
  const statements: SqlStatement[] = [];
  const profile = resolveEffectiveProfileConfig(spec);
  const profileTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__entity_profile'),
    dialect
  );
  const crosswalksTable = buildFqName(
    targetSchema,
    outputTableName(spec.entity, '__crosswalks'),
    dialect
  );
  const displayNameField = profile.displayName?.field;
  const profileAttrsExpr = `ep.${quoteIdentifier('profile_attrs', dialect)}`;
  const attributesByLowerField = buildAttributeMap(profile.attributes);
  const seenViewNames = new Map<string, string>();

  for (const input of spec.inputs) {
    const idFields = input.idFields;
    if (!idFields || idFields.length === 0) {
      warnings.push(`Input '${input.ref}' has no idFields; skipping clean view generation.`);
      continue;
    }

    if (input.sourceColumns === undefined) {
      warnings.push(
        `Input '${input.ref}' has no known source columns; skipping clean view generation. ` +
          `Add schema.columns to the source spec so the Entity Graph clean view can avoid column collisions.`
      );
      continue;
    }

    const viewName = resolveCleanViewName(input.ref, spec.entity, viewConfig.namePattern);
    const previousRef = seenViewNames.get(viewName);
    if (previousRef !== undefined) {
      throw new Error(
        `Clean view name collision: inputs '${previousRef}' and '${input.ref}' both resolve to view '${viewName}'. ` +
          `Set profile.views.name_pattern to include {entity} or a source-specific segment to disambiguate.`
      );
    }
    seenViewNames.set(viewName, input.ref);

    const fqViewName = buildFqName(targetSchema, viewName, dialect);
    const columns = buildColumnSelections(
      input.sourceColumns,
      profileAttrsExpr,
      displayNameField,
      attributesByLowerField,
      viewConfig.includeEntityGraphMetadata,
      dialect
    );

    const selectSql = [
      `SELECT`,
      ...columns.map(
        (column, index) => `  ${index === columns.length - 1 ? column : `${column},`}`
      ),
      `FROM ${input.fqTableName} src`,
      `LEFT JOIN ${crosswalksTable} cw`,
      `  ON ${buildSourceEntityIdExpr(idFields, dialect, 'src')} = cw.${quoteIdentifier(
        'source_entity_id',
        dialect
      )}`,
      `  AND cw.${quoteIdentifier('source_ref', dialect)} = ${quoteLiteral(input.ref, dialect)}`,
      `LEFT JOIN ${profileTable} ep`,
      `  ON cw.${quoteIdentifier('entity_id', dialect)} = ep.${quoteIdentifier('entity_id', dialect)}`,
    ].join('\n');

    statements.push({
      name: `clean_view_${input.alias}`,
      sql: [`CREATE OR REPLACE VIEW ${fqViewName} AS (`, selectSql, `)`].join('\n'),
    });
  }

  return { statements, warnings };
}
