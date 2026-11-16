import { describe, expect, it, vi } from 'vitest';

import { BobsledMcpServer, createEntityGraphMcpServer } from '../../../../src/mcp/index.js';
import type { PrincipalContext } from '../../../../src/mcp/server.js';

import type { MatchContext } from '@bobsled-inc/entity-graph/runtime/services';

const PRINCIPAL: PrincipalContext = { principal_id: 'user-1' };

const SPEC: MatchContext['spec'] = {
  name: 'company_resolution',
  entity: 'company',
  description: 'MCP fixture.',
  inputs: [
    {
      ref: 'crm.accounts',
      fqTableName: 'main.accounts',
      alias: 's0',
      idFields: ['account_id'],
      sourceColumns: ['account_id', 'name'],
    },
  ],
  standardize: [{ field: 'name', transforms: ['normalize_company'] }],
  blocking: { rules: [{ name: 'name', key: 'standardized_name' }] },
  deterministicRules: [
    {
      name: 'exact_name',
      conditions: [{ field: 'name', operator: 'exact', bothNotNull: true }],
      action: 'auto_merge',
      confidence: 1,
    },
  ],
  thresholds: { autoMerge: 0.95, review: 0.6, autoReject: 0.4 },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
  targetSchema: 'entity_graph',
};

function createRunner() {
  return {
    run: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('company__golden')) {
        return [{ entity_id: 'entity-1', display_name: 'Acme', trust_score: 0.98 }];
      }
      if (sql.includes('company__entity_quality')) {
        return [{ entity_id: 'entity-1', trust_tier: 'trusted' }];
      }
      if (sql.includes('company__crosswalks')) {
        return [{ record_id: 'record-1', entity_id: 'entity-1', source_ref: 'crm.accounts' }];
      }
      if (sql.includes('__entity_relationship')) {
        return [{ relationship_id: 'rel-1', relation_type: 'owns', left_entity_id: 'entity-1' }];
      }
      if (sql.includes('company__standardized')) {
        return [{ entity_id: 'entity-1', record_id: 'record-1' }];
      }
      return [];
    }),
  };
}

describe('entity graph MCP tools', () => {
  it('lists read-only entity tools with annotations', () => {
    const server = new BobsledMcpServer({ env: {} });
    const tools = createEntityGraphMcpServer({
      server,
      runner: createRunner(),
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      principal: PRINCIPAL,
    }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'entity_search',
        'entity_get',
        'entity_match',
        'entity_relationships',
        'entity_explain',
      ])
    );
    expect(tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
  });

  it('fetches an entity and returns permission/routing envelopes', async () => {
    const server = new BobsledMcpServer({ env: {} });
    const result = await createEntityGraphMcpServer({
      server,
      runner: createRunner(),
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      principal: PRINCIPAL,
    }).callTool('entity_get', { entity_type: 'company', entity_id: 'entity-1' });
    expect(result.result).toMatchObject({ entity_id: 'entity-1' });
    expect(result.permissions).toEqual({ enforced: false, reason: 'no_adapter_registered' });
    expect(result.routing_metadata?.resolved_via).toBe('direct');
  });

  it('runs lookup-only entity_match through the shared match service', async () => {
    const server = new BobsledMcpServer({ env: {} });
    const result = await createEntityGraphMcpServer({
      server,
      runner: createRunner(),
      schema: 'entity_graph',
      dialect: 'duckdb',
      specs: [SPEC],
      principal: PRINCIPAL,
    }).callTool('entity_match', {
      entity_type: 'company',
      record: { account_id: 'a2', name: 'Acme LLC' },
    });
    expect(result.result).toMatchObject({ entity_id: 'entity-1', band: 'auto_merge' });
  });

  it('rejects unknown entity types before querying graph tables', async () => {
    const server = new BobsledMcpServer({ env: {} });
    const runner = createRunner();

    await expect(
      createEntityGraphMcpServer({
        server,
        runner,
        schema: 'entity_graph',
        dialect: 'duckdb',
        specs: [SPEC],
        principal: PRINCIPAL,
      }).callTool('entity_search', { entity_type: 'person' })
    ).rejects.toThrow(/No entity spec found for 'person'/);

    expect(runner.query).not.toHaveBeenCalled();
  });

  it('rejects calls without a principal in fail-closed mode', async () => {
    const server = new BobsledMcpServer({ env: {} });
    await expect(
      createEntityGraphMcpServer({
        server,
        runner: createRunner(),
        schema: 'entity_graph',
        dialect: 'duckdb',
        specs: [SPEC],
        principal: null,
      }).callTool('entity_search', { entity_type: 'company' })
    ).rejects.toThrow(/PermissionsNotConfigured/);
  });
});
