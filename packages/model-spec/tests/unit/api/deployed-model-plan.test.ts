import { describe, expect, it } from 'vitest';

import {
  analyzeDeployedModelProject,
  planDeployedModelExecution,
} from '../../../src/api/deployed-model-plan.js';
import { CommandError } from '../../../src/errors.js';

function liveSource(connection: string, name: string, resource = name): Record<string, unknown> {
  return {
    spec_version: '0.2',
    name,
    type: 'source',
    source_type: 'api_resource',
    integration: `${connection}_integration`,
    resource,
    connection,
    mode: 'live',
    schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
  };
}

function warehouseSource(connection: string, name: string): Record<string, unknown> {
  return {
    spec_version: '0.2',
    name,
    type: 'source',
    source_type: 'warehouse_table',
    connection,
    table: `main.${name}`,
    schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
  };
}

function model(
  name: string,
  source: string,
  joins: Array<{ ref: string; alias?: string; on: string }> = []
): Record<string, unknown> {
  return {
    spec_version: '0.2',
    name,
    type: 'model',
    description: `${name} model`,
    grain: 'id',
    source: { ref: source },
    joins: joins.map((join) => ({ type: 'left', ...join })),
    columns: [{ name: 'id', expr: 'id' }],
    materialization: { type: 'view' },
  };
}

function agenticModel(name: string, source: string): Record<string, unknown> {
  return {
    spec_version: '0.2',
    name,
    type: 'model',
    model_kind: 'agentic',
    description: `${name} model`,
    grain: ['id'],
    sources: { input: { ref: source } },
    llm: { profile: 'test' },
    limits: { tokens: 1000, timeout_seconds: 60 },
    plan: {
      steps: [
        {
          id: 'enrich',
          source: { ref: 'input' },
          map: { over: 'input', group_by: ['id'] },
          execution: { mode: 'agent_loop' },
          instructions: 'Return each input id.',
          columns: [{ name: 'id', type: 'integer', nullable: false }],
        },
      ],
    },
    output: { from: 'enrich' },
    materialization: { type: 'table', strategy: 'replace_processed_keys', keys: ['id'] },
  };
}

describe('deployed model planning', () => {
  it('analyzes a warehouse SQL -> agentic -> SQL graph', () => {
    const analyses = analyzeDeployedModelProject({
      sources: [warehouseSource('warehouse', 'users')],
      models: [
        model('base_users', 'warehouse.users'),
        agenticModel('enriched_users', 'BASE_USERS'),
        model('user_rollup', 'ENRICHED_USERS'),
      ],
    });

    expect(analyses.map((analysis) => analysis.executionMode)).toEqual([
      'materialized',
      'materialized',
      'materialized',
    ]);
    expect(analyses[2]).toMatchObject({
      modelName: 'user_rollup',
      mixed: false,
      closure: {
        models: ['base_users', 'enriched_users', 'user_rollup'],
        sources: ['warehouse.users'],
        liveSources: [],
        materializedSources: ['warehouse.users'],
      },
    });
  });

  it('rejects unknown refs declared by agentic models', () => {
    expect(() =>
      analyzeDeployedModelProject({
        sources: [],
        models: [agenticModel('enriched_users', 'missing')],
      })
    ).toThrow(/enriched_users.*unknown source or model "missing"/);
  });

  it('rejects cycles through SQL and agentic models', () => {
    expect(() =>
      analyzeDeployedModelProject({
        sources: [],
        models: [
          agenticModel('enriched_users', 'user_rollup'),
          model('user_rollup', 'enriched_users'),
        ],
      })
    ).toThrow(/Circular dependency/);
  });

  it.each(['ENRICHED_USERS', 'USER_ROLLUP'])(
    'rejects query-time planning for %s with an agentic execution dependency',
    (target) => {
      expect(() =>
        planDeployedModelExecution({
          sources: [warehouseSource('warehouse', 'users')],
          models: [
            model('base_users', 'warehouse.users'),
            agenticModel('enriched_users', 'base_users'),
            model('user_rollup', 'enriched_users'),
          ],
          model: target,
        })
      ).toThrow(
        expect.objectContaining({
          constructor: CommandError,
          exitCode: 2,
          message: expect.stringMatching(
            /execution closure contains agentic model "enriched_users"/
          ),
        })
      );
    }
  );

  it.each(['warehouse_users', 'live_users'])(
    'still plans unrelated SQL model %s in a project with agentic models',
    (target) => {
      const plan = planDeployedModelExecution({
        sources: [warehouseSource('warehouse', 'users'), liveSource('api', 'users')],
        models: [
          agenticModel('enriched_users', 'warehouse.users'),
          model('warehouse_users', 'warehouse.users'),
          model('live_users', 'api.users'),
        ],
        model: target,
      });
      expect(plan.closure.models).toEqual([target]);
      expect(plan.executionMode).toBe(target === 'live_users' ? 'on_read' : 'materialized');
      expect(plan.sourceBindings).toHaveLength(1);
      expect(plan.sql).toContain('__dogsled_source_1');
    }
  );

  it('derives transitive on-read mode and the full closure', () => {
    const sources = [liveSource('api', 'users')];
    const models = [model('active_users', 'API.Users'), model('user_rollup', 'ACTIVE_USERS')];

    const analyses = analyzeDeployedModelProject({ sources, models });
    expect(analyses).toEqual([
      expect.objectContaining({
        modelName: 'active_users',
        executionMode: 'on_read',
        mixed: false,
      }),
      expect.objectContaining({
        modelName: 'user_rollup',
        executionMode: 'on_read',
        mixed: false,
        closure: {
          models: ['active_users', 'user_rollup'],
          sources: ['api.users'],
          liveSources: ['api.users'],
          materializedSources: [],
        },
      }),
    ]);
  });

  it('marks warehouse-only and mixed models correctly', () => {
    const sources = [warehouseSource('warehouse', 'orders'), liveSource('api', 'users')];
    const models = [
      model('orders', 'warehouse.orders'),
      model('orders_with_users', 'warehouse.orders', [
        { ref: 'api.users', alias: 'users', on: 'warehouse.orders.id = api.users.id' },
      ]),
    ];

    const analyses = analyzeDeployedModelProject({ sources, models });
    expect(analyses[0]).toMatchObject({ executionMode: 'materialized', mixed: false });
    expect(analyses[1]).toMatchObject({
      executionMode: 'on_read',
      mixed: true,
      closure: {
        liveSources: ['api.users'],
        materializedSources: ['warehouse.orders'],
      },
    });
  });

  it('does not classify a lazy API source as live', () => {
    const lazy = { ...liveSource('api', 'users'), mode: 'lazy' };

    expect(
      analyzeDeployedModelProject({
        sources: [lazy],
        models: [model('users_model', 'api.users')],
      })
    ).toEqual([
      expect.objectContaining({
        executionMode: 'materialized',
        mixed: false,
        closure: expect.objectContaining({
          liveSources: [],
          materializedSources: ['api.users'],
        }),
      }),
    ]);
  });

  it('assigns distinct internal tables when Connections reuse a source name', () => {
    const sources = [liveSource('product_api', 'users'), liveSource('support_api', 'users')];
    const models = [
      model('joined_users', 'product_api.users', [
        {
          ref: 'support_api.users',
          alias: 'support_users',
          on: 'product_api.users.id = support_api.users.id',
        },
      ]),
    ];

    const plan = planDeployedModelExecution({ sources, models, model: 'JOINED_USERS' });
    expect(plan.executionMode).toBe('on_read');
    expect(plan.sourceBindings).toHaveLength(2);
    expect(plan).not.toHaveProperty('maxRows');
    expect(plan).not.toHaveProperty('credentials');
    expect(new Set(plan.sourceBindings.map((binding) => binding.internalTable)).size).toBe(2);
    for (const binding of plan.sourceBindings) {
      expect(plan.sql).toContain(binding.internalTable.split('.')[1]!);
    }
  });

  it('rejects case-only source collisions', () => {
    expect(() =>
      analyzeDeployedModelProject({
        sources: [liveSource('CRM', 'Users'), liveSource('crm', 'users')],
        models: [model('users_model', 'crm.users')],
      })
    ).toThrow(/Duplicate source ref.*case-insensitive/i);
  });

  it('uses the safe internal table for an exact authored-case source ref', () => {
    const plan = planDeployedModelExecution({
      sources: [liveSource('CRM', 'Users')],
      models: [model('users_model', 'CRM.Users')],
      model: 'users_model',
    });

    expect(plan.sql).toContain('__dogsled_source_1');
    expect(plan.sql).not.toContain('sources.Users');
  });
});
