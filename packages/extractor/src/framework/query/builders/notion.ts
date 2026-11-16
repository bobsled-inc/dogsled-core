import type { FilterBuilder, FilterBuilderConfig, QueryPredicate } from '../types.js';
import { QueryBuilderError } from '../types.js';

type NotionPropertyType = 'checkbox' | 'date' | 'number' | 'rich_text' | 'select';

export const notionFilterBuilder: FilterBuilder = {
  id: 'notion/database-query',
  label: 'Notion database query',
  description: 'Builds Notion database query filters from Bobsled Core query predicates.',
  integrations: ['notion'],
  build(config, predicates) {
    const filters = predicates.flatMap((predicate) => buildNotionPredicate(config, predicate));
    const filter =
      filters.length === 0
        ? undefined
        : filters.length === 1
          ? filters[0]
          : {
              and: filters,
            };

    if (!filter) {
      return {};
    }

    return config.argument ? { [config.argument]: filter } : { filter };
  },
};

function buildNotionPredicate(
  config: FilterBuilderConfig,
  predicate: QueryPredicate
): Record<string, unknown>[] {
  if (predicate.operator === 'in') {
    const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
    return [
      {
        or: values.map((value) =>
          buildSingleNotionPredicate(config, { ...predicate, operator: 'eq', value })
        ),
      },
    ];
  }

  return [buildSingleNotionPredicate(config, predicate)];
}

function buildSingleNotionPredicate(
  config: FilterBuilderConfig,
  predicate: QueryPredicate
): Record<string, unknown> {
  const property = config.field_map?.[predicate.field] ?? predicate.field;
  const propertyType = resolvePropertyType(config, predicate);
  const operator = resolveNotionOperator(propertyType, predicate.operator);

  return {
    property,
    [propertyType]: {
      [operator]: predicate.value,
    },
  };
}

function resolvePropertyType(
  config: FilterBuilderConfig,
  predicate: QueryPredicate
): NotionPropertyType {
  const configured = config.field_types?.[predicate.field];
  if (isNotionPropertyType(configured)) {
    return configured;
  }

  if (typeof predicate.value === 'boolean') {
    return 'checkbox';
  }
  if (typeof predicate.value === 'number') {
    return 'number';
  }
  if (typeof predicate.value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(predicate.value)) {
    return 'date';
  }
  return 'rich_text';
}

function resolveNotionOperator(
  propertyType: NotionPropertyType,
  operator: QueryPredicate['operator']
): string {
  if (propertyType === 'date') {
    const mapped: Partial<Record<QueryPredicate['operator'], string>> = {
      eq: 'equals',
      ne: 'does_not_equal',
      gte: 'on_or_after',
      lte: 'on_or_before',
      gt: 'after',
      lt: 'before',
      not: 'does_not_equal',
      in: 'equals',
    };
    return assertSupportedOperator(propertyType, operator, mapped[operator]);
  }

  if (propertyType === 'number') {
    const mapped: Partial<Record<QueryPredicate['operator'], string>> = {
      eq: 'equals',
      ne: 'does_not_equal',
      gte: 'greater_than_or_equal_to',
      lte: 'less_than_or_equal_to',
      gt: 'greater_than',
      lt: 'less_than',
      not: 'does_not_equal',
      in: 'equals',
    };
    return assertSupportedOperator(propertyType, operator, mapped[operator]);
  }

  if (propertyType === 'checkbox') {
    const mapped: Partial<Record<QueryPredicate['operator'], string>> = {
      eq: 'equals',
      ne: 'does_not_equal',
      not: 'does_not_equal',
      in: 'equals',
    };
    return assertSupportedOperator(propertyType, operator, mapped[operator]);
  }

  const mapped: Partial<Record<QueryPredicate['operator'], string>> = {
    eq: 'equals',
    ne: 'does_not_equal',
    contains: 'contains',
    not: 'does_not_equal',
    in: 'equals',
  };
  return assertSupportedOperator(propertyType, operator, mapped[operator]);
}

function assertSupportedOperator(
  propertyType: NotionPropertyType,
  operator: QueryPredicate['operator'],
  notionOperator: string | undefined
): string {
  if (!notionOperator) {
    throw new QueryBuilderError(
      `Notion ${propertyType} filters do not support operator "${operator}".`
    );
  }
  return notionOperator;
}

function isNotionPropertyType(value: unknown): value is NotionPropertyType {
  return (
    value === 'checkbox' ||
    value === 'date' ||
    value === 'number' ||
    value === 'rich_text' ||
    value === 'select'
  );
}
