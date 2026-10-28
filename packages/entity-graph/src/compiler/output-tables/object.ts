import type { OutputTableDef } from './index.js';

export const OBJECT_OUTPUT_TABLES = (
  [
    {
      suffix: 'object_types',
      ddlStrategy: 'create_or_replace',
      columns: [
        { name: 'name', type: 'STRING' },
        { name: 'identity_resolution_ref', type: 'STRING' },
        { name: 'links_json', type: 'STRING' },
        { name: 'actions_json', type: 'STRING' },
      ],
    },
  ] as const
).map((table) => ({
  ...table,
  stage: 'object' as const,
})) satisfies readonly OutputTableDef[];
