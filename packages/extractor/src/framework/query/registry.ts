import { hubspotFilterBuilder } from './builders/hubspot.js';
import { notionFilterBuilder } from './builders/notion.js';

import type {
  FilterBuilder,
  FilterBuilderConfig,
  FilterBuilderMetadata,
  FilterBuilderOutput,
  QueryPredicate,
} from './types.js';
import { QueryBuilderError } from './types.js';

const FILTER_BUILDERS = new Map<string, FilterBuilder>(
  [hubspotFilterBuilder, notionFilterBuilder].map((builder) => [builder.id, builder])
);

export function listFilterBuilders(): FilterBuilderMetadata[] {
  return [...FILTER_BUILDERS.values()]
    .map(({ id, label, description, integrations }) => ({
      id,
      label,
      description,
      integrations,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function invokeBuilder(
  name: string,
  rawConfig: FilterBuilderConfig,
  predicates: QueryPredicate[]
): FilterBuilderOutput {
  const builder = FILTER_BUILDERS.get(name);
  if (!builder) {
    throw new QueryBuilderError(
      `Unknown query filter builder "${name}". Known builders: ${listFilterBuilders()
        .map((entry) => entry.id)
        .join(', ')}.`
    );
  }

  return builder.build(rawConfig, predicates);
}
