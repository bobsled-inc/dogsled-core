import { describe, expect, it } from 'vitest';

import { generateSelectSql } from '../../../src/compiler/codegen.js';
import type { ResolvedTransformSpec, SourceEntryRegistry } from '../../../src/compiler/parser.js';

describe('codegen — api_resource FROM', () => {
  it('emits "sources"."<name>" on duckdb', () => {
    const entryRegistry: SourceEntryRegistry = new Map([
      [
        'github_prod.issues',
        {
          kind: 'api_resource',
          fqRef: 'sources.issues',
          integration: 'github',
          resource: 'issues',
          connection: 'github_prod',
          columns: [{ name: 'id', sqlType: 'INTEGER', type: 'integer' }],
        },
      ],
    ]);
    const spec: ResolvedTransformSpec = {
      name: 'stg',
      description: '',
      grain: 'issue_id',
      trustTier: 'bronze',
      sourceRef: 'github_prod.issues',
      source: {
        fqTableName: 'github_prod.issues',
        alias: 't0',
        refKey: 'github_prod.issues',
      },
      joins: [],
      columns: [{ name: 'issue_id', expr: 'id' }],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'duckdb', undefined, { entryRegistry });

    expect(sql).toMatch(/FROM\s+"sources"\."issues"/i);
  });
});
