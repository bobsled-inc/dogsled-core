import {
  buildFqName,
  createOrReplaceTableAs,
  quoteIdentifier,
  quoteLiteral,
} from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { ENTITY_GRAPH_SCHEMA } from '../audit/codegen.js';
import { nullString } from '../identity/sql.js';
import type { SqlStatement } from '../identity/types.js';
import type { ResolvedObjectSpec } from './types.js';

export interface ObjectCompileOptions {
  contractSchema?: string;
}

export function generateObjectTypesSql(
  specs: readonly ResolvedObjectSpec[],
  dialect: SupportedDialect,
  options: ObjectCompileOptions = {}
): SqlStatement {
  const contractSchema = options.contractSchema?.trim() || ENTITY_GRAPH_SCHEMA;
  const tableName = buildFqName(contractSchema, 'object_types', dialect);
  const rows = specs.map((spec) => {
    const links = spec.links.map((link) => ({
      relation_ref: link.relationRef,
      relation_name: link.relationName,
      direction: link.direction,
    }));
    const actions = spec.actions.map((action) => ({
      action_ref: action.actionRef,
      label: action.label,
    }));
    const columns = [
      `${quoteLiteral(spec.name, dialect)} AS ${quoteIdentifier('name', dialect)}`,
      `${quoteLiteral(spec.identityResolutionRef, dialect)} AS ${quoteIdentifier('identity_resolution_ref', dialect)}`,
      `${quoteLiteral(JSON.stringify(links), dialect)} AS ${quoteIdentifier('links_json', dialect)}`,
      `${quoteLiteral(JSON.stringify(actions), dialect)} AS ${quoteIdentifier('actions_json', dialect)}`,
    ];
    return [
      `SELECT`,
      ...columns.map((column, index) => `  ${column}${index === columns.length - 1 ? '' : ','}`),
    ].join('\n');
  });

  const empty = [
    `SELECT`,
    `  ${nullString(dialect)} AS ${quoteIdentifier('name', dialect)},`,
    `  ${nullString(dialect)} AS ${quoteIdentifier('identity_resolution_ref', dialect)},`,
    `  ${nullString(dialect)} AS ${quoteIdentifier('links_json', dialect)},`,
    `  ${nullString(dialect)} AS ${quoteIdentifier('actions_json', dialect)}`,
    `WHERE 1 = 0`,
  ].join('\n');

  return {
    name: 'entity_graph_object_types',
    sql: [
      createOrReplaceTableAs(tableName, dialect),
      rows.length > 0 ? rows.join('\nUNION ALL\n') : empty,
    ].join('\n'),
    tableCreated: `${contractSchema}.object_types`,
  };
}
