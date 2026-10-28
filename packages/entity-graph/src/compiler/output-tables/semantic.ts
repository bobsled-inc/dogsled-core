import type { OutputTableDef } from './index.js';

export const SEMANTIC_OUTPUT_TABLES = (
  [
    {
      suffix: '__embedding_cache',
      ddlStrategy: 'create_if_not_exists',
      columns: [
        { name: 'content_hash', type: 'STRING' },
        { name: 'provider', type: 'STRING' },
        { name: 'embedding', type: 'ARRAY_FLOAT' },
      ],
    },
    {
      suffix: '__pair_semantic_scores',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'pair_id', type: 'STRING' },
        { name: 'field', type: 'STRING' },
        { name: 'semantic_score', type: 'FLOAT' },
        { name: 'evaluated_at', type: 'TIMESTAMP' },
      ],
    },
  ] as const
).map((table) => ({
  ...table,
  stage: 'semantic' as const,
})) satisfies readonly OutputTableDef[];
