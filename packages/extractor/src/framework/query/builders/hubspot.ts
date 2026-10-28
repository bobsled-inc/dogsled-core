import type { FilterBuilder, FilterBuilderConfig, QueryPredicate } from '../types.js';

const HUBSPOT_OPERATOR_MAP: Record<QueryPredicate['operator'], string> = {
  eq: 'EQ',
  contains: 'CONTAINS_TOKEN',
  gte: 'GTE',
  lte: 'LTE',
  ne: 'NEQ',
  lt: 'LT',
  gt: 'GT',
  not: 'NEQ',
  in: 'IN',
};

export const hubspotFilterBuilder: FilterBuilder = {
  id: 'hubspot/crm-search',
  label: 'HubSpot CRM search',
  description: 'Builds HubSpot CRM v3 search filterGroups from Dogsled query predicates.',
  integrations: ['hubspot'],
  build(config, predicates) {
    const filters = predicates.map((predicate) => buildHubSpotFilter(config, predicate));
    const baseGroups = Array.isArray(config.base) ? config.base : [];
    const filterGroups =
      filters.length === 0
        ? baseGroups
        : [
            ...baseGroups,
            {
              filters,
            },
          ];

    return wrapArgument(config, { filterGroups });
  },
};

function buildHubSpotFilter(
  config: FilterBuilderConfig,
  predicate: QueryPredicate
): Record<string, unknown> {
  const operator =
    config.operator_map?.[predicate.operator] ?? HUBSPOT_OPERATOR_MAP[predicate.operator];
  const propertyName = config.field_map?.[predicate.field] ?? predicate.field;

  if (predicate.operator === 'in') {
    return {
      propertyName,
      operator,
      values: Array.isArray(predicate.value) ? predicate.value : [predicate.value],
    };
  }

  return {
    propertyName,
    operator,
    value: predicate.value,
  };
}

function wrapArgument(
  config: FilterBuilderConfig,
  value: Record<string, unknown>
): Record<string, unknown> {
  if (!config.argument) {
    return value;
  }
  return value[config.argument] !== undefined && Object.keys(value).length === 1
    ? value
    : { [config.argument]: value };
}
