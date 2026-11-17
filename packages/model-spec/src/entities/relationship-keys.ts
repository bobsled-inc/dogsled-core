/**
 * Relationship key checks.
 *
 * The "one" side of a relationship must be unique on its join columns, and the
 * declared primary key is how Dogsled and downstream semantic layers know that.
 * Warehouses that trust declared keys, such as Snowflake semantic views, never
 * check them against the data, so a relationship whose one side has no primary
 * key, or joins on other columns, returns wrong numbers rather than an error.
 *
 * These checks only warn. Project validation and Ossie export share them.
 */

import type { RelationshipSpec } from './relationship.js';

export const RELATIONSHIP_KEY_WARNING_CODES = [
  'relationship_target_key_missing',
  'relationship_target_key_mismatch',
] as const;
export type RelationshipKeyWarningCode = (typeof RELATIONSHIP_KEY_WARNING_CODES)[number];

export interface RelationshipKeyWarning {
  code: RelationshipKeyWarningCode;
  relationship: string;
  /** The relationship side whose dataset must be unique on its join columns. */
  side: 'left' | 'right';
  /** The dataset reference as the relationship spells it. */
  dataset: string;
  /** The dataset's declared primary key, in declaration order. Empty when it declares none. */
  primaryKey: string[];
  /** The join columns on this side, in relationship order. */
  joinColumns: string[];
  message: string;
  remedy: string;
}

export type KeyedRelationship = Pick<
  RelationshipSpec,
  'name' | 'left_model' | 'right_model' | 'join_columns' | 'relationship_type'
>;

const relationshipKeyWarningCodes: ReadonlySet<string> = new Set(RELATIONSHIP_KEY_WARNING_CODES);

export function isRelationshipKeyWarningCode(code: string): code is RelationshipKeyWarningCode {
  return relationshipKeyWarningCodes.has(code);
}

function columnFields(column: unknown): { name?: unknown; primary_key?: unknown } {
  return column !== null && typeof column === 'object' ? column : {};
}

/**
 * A parsed source or model's declared primary key, given its output columns. Agentic
 * models declare their key as `grain`, because their output columns cannot carry
 * `primary_key`; a grain column the model does not output is no key. Other datasets
 * mark columns `primary_key: true`, in declaration order.
 */
export function datasetPrimaryKey(
  document: Readonly<Record<string, unknown>>,
  columns: readonly unknown[]
): string[] {
  if (document['model_kind'] === 'agentic') {
    const grain = document['grain'];
    const keys = (Array.isArray(grain) ? grain : [grain]).filter(
      (key): key is string => typeof key === 'string'
    );
    const names = new Set(columns.map((column) => columnFields(column).name));
    return keys.length && keys.every((key) => names.has(key)) ? keys : [];
  }
  return columns.flatMap((column) => {
    const { name, primary_key: primaryKey } = columnFields(column);
    return primaryKey === true && typeof name === 'string' ? [name] : [];
  });
}

function oneSides(type: RelationshipSpec['relationship_type']): Array<'left' | 'right'> {
  switch (type) {
    case 'many_to_one':
      return ['right'];
    case 'one_to_many':
      return ['left'];
    case 'one_to_one':
      return ['left', 'right'];
    case 'many_to_many':
      return [];
  }
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left.map((name) => name.toLowerCase()));
  const b = new Set(right.map((name) => name.toLowerCase()));
  return a.size === b.size && [...a].every((name) => b.has(name));
}

/**
 * Warn when a relationship's one side does not join on that dataset's declared
 * primary key. `primaryKeyOf` returns the dataset's declared key (empty when it
 * declares none), or `undefined` for a dataset it cannot resolve; unresolved
 * datasets are left to reference validation. Column names compare as sets,
 * ignoring case and order. `many_to_many` relationships have no one side.
 */
export function relationshipKeyWarnings(
  relationship: KeyedRelationship,
  primaryKeyOf: (dataset: string) => readonly string[] | undefined
): RelationshipKeyWarning[] {
  const warnings: RelationshipKeyWarning[] = [];
  const name = relationship.name;
  const type = relationship.relationship_type;
  for (const side of oneSides(type)) {
    const dataset = side === 'left' ? relationship.left_model : relationship.right_model;
    const declared = primaryKeyOf(dataset);
    if (declared === undefined) continue;
    const primaryKey = [...declared];
    const joinColumns = relationship.join_columns.map((pair) => pair[side]);
    const joins = joinColumns.join(', ');
    const subject = `Relationship ${name} is ${type}, so ${dataset} must be unique on its join columns (${joins})`;
    if (!primaryKey.length) {
      warnings.push({
        code: 'relationship_target_key_missing',
        relationship: name,
        side,
        dataset,
        primaryKey,
        joinColumns,
        message: `${subject}, but ${dataset} declares no primary key.`,
        remedy: `Mark the columns that identify each ${dataset} row with primary_key: true, and join on them.`,
      });
    } else if (!sameColumns(joinColumns, primaryKey)) {
      const key = primaryKey.join(', ');
      warnings.push({
        code: 'relationship_target_key_mismatch',
        relationship: name,
        side,
        dataset,
        primaryKey,
        joinColumns,
        message: `${subject}, but its declared primary key is ${key}.`,
        remedy: `Join on ${key}, or correct the primary_key columns of ${dataset}.`,
      });
    }
  }
  return warnings;
}
