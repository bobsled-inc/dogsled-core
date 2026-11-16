import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  exportOssieDocument,
  importOssieDocuments,
  type ExportOssieDocumentRequest,
} from '../../src/interchange/index.js';

const source = {
  spec_version: '0.2',
  type: 'source',
  source_type: 'warehouse_table',
  name: 'raw_orders',
  description: 'Raw orders',
  connection: 'warehouse',
  table: 'ANALYTICS.RAW.RAW_ORDERS',
  schema: {
    columns: [
      {
        name: 'order_id',
        type: 'BIGINT',
        primary_key: true,
        semantic_expression: {
          dialects: [{ dialect: 'ANSI_SQL', expression: 'order_id' }],
        },
      },
      { name: 'amount', type: 'DECIMAL(18,2)' },
    ],
  },
  interchange: {
    ossie: {
      custom_extensions: [{ vendor_name: 'DBT', data: '{"model":"raw_orders"}' }],
      fields: [
        {
          origin_id: 'raw-amount',
          field: 'amount',
          custom_extensions: [{ vendor_name: 'CATALOG', data: 'keep field data' }],
        },
      ],
    },
  },
} as const;

const model = {
  spec_version: '0.2',
  type: 'model',
  name: 'completed_orders',
  description: 'Completed orders',
  grain: ['order_id'],
  source: { ref: 'warehouse.raw_orders' },
  where: "raw_orders.status = 'complete'",
  materialization: { type: 'table' },
  columns: [
    { name: 'order_id', type: 'BIGINT', expr: 'raw_orders.order_id', primary_key: true },
    { name: 'amount', type: 'DECIMAL(18,2)', expr: 'raw_orders.amount' },
  ],
} as const;

const agenticModel = {
  spec_version: '0.2',
  type: 'model',
  model_kind: 'agentic',
  name: 'researched_orders',
  description: 'Orders enriched by an agent',
  grain: ['order_id'],
  sources: { orders: { ref: 'warehouse.raw_orders' } },
  llm: { profile: 'review' },
  plan: {
    steps: [
      {
        id: 'research',
        source: { ref: 'orders' },
        execution: { mode: 'llm_call' },
        instructions: 'Summarize the order.',
        map: { over: 'orders', group_by: ['order_id'] },
        columns: [
          { name: 'order_id', type: 'integer', nullable: false },
          { name: 'summary', type: 'string', nullable: true },
        ],
      },
    ],
  },
  output: { from: 'research' },
  materialization: {
    type: 'table',
    strategy: 'replace_processed_keys',
    keys: ['order_id'],
  },
} as const;

const metric = {
  spec_version: '0.2',
  type: 'metric',
  name: 'completed_revenue',
  description: 'Completed revenue',
  model: 'completed_orders',
  expression: 'SUM({completed_orders.amount})',
  datatype: 'Decimal',
  synonyms: ['recognized revenue'],
  tags: ['finance'],
  interchange: {
    ossie: {
      custom_extensions: [{ vendor_name: 'DBT', data: '{"metric":"revenue"}' }],
    },
  },
} as const;

const relationship = {
  spec_version: '0.2',
  type: 'relationship',
  name: 'completed_to_raw',
  description: 'Completed order to raw order',
  left_model: 'completed_orders',
  right_model: 'warehouse.raw_orders',
  join_columns: [{ left: 'order_id', right: 'order_id' }],
  join_type: 'left',
  relationship_type: 'many_to_one',
  tags: ['sales'],
} as const;

function request(overrides: Partial<ExportOssieDocumentRequest> = {}): ExportOssieDocumentRequest {
  return {
    project: {
      sources: [source],
      models: [model],
      metrics: [metric],
      relationships: [relationship],
      addresses: {
        'warehouse.raw_orders': 'ANALYTICS.RAW.RAW_ORDERS',
        completed_orders: 'ANALYTICS.MART.COMPLETED_ORDERS',
      },
    },
    semanticModelName: 'sales',
    selection: { all: true },
    ...overrides,
  };
}

function projectWithLongDescriptions(
  count: number,
  length: number
): ExportOssieDocumentRequest['project'] {
  const models = Array.from({ length: count }, (_, index) => ({
    ...model,
    name: `completed_orders_${index}`,
    description: 'x'.repeat(length),
  }));
  return {
    ...request().project,
    models,
    metrics: [],
    relationships: [],
    addresses: {
      ...request().project.addresses,
      ...Object.fromEntries(
        models.map((entry) => [entry.name, `ANALYTICS.MART.${entry.name.toUpperCase()}`])
      ),
    },
  };
}

describe('Ossie export converter', () => {
  it('exports standard Ossie 0.1.1 by default and reports native losses', () => {
    const result = exportOssieDocument(request());

    expect(result).toMatchObject({ ok: true, ready: true });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.document).toMatchObject({
      version: '0.1.1',
      semantic_model: [
        {
          name: 'sales',
          datasets: [
            { name: 'completed_orders', source: 'ANALYTICS.MART.COMPLETED_ORDERS' },
            { name: 'raw_orders', source: 'ANALYTICS.RAW.RAW_ORDERS' },
          ],
          metrics: [{ name: 'completed_revenue' }],
          relationships: [{ name: 'completed_to_raw' }],
        },
      ],
    });
    expect(result.files[0]?.content).not.toContain('BOBSLED');
    expect(result.files[0]?.content).not.toContain('datatype:');
    expect(result.files[0]?.content).toContain('vendor_name: DBT');
    expect(result.files[0]?.content).not.toContain('vendor_name: CATALOG');
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'native_metadata_not_supported_by_profile',
        'metric_datatype_not_supported_by_profile',
        'relationship_join_type_not_preserved',
      ])
    );
    expect(exportOssieDocument(request({ strict: true }))).toMatchObject({
      ok: true,
      ready: false,
    });
  });

  it('exports version 2 metadata and reimports the supported native meaning', () => {
    const result = exportOssieDocument(
      request({
        ossieVersion: '0.2.0.dev0',
      })
    );

    expect(result).toMatchObject({ ok: true, ready: true });
    const document = result.files[0]?.document as {
      datasets: Array<Record<string, unknown>>;
      metrics: Array<Record<string, unknown>>;
      relationships: Array<Record<string, unknown>>;
    };
    expect(document.datasets).toHaveLength(2);
    expect(document.metrics).toHaveLength(1);
    expect(document.relationships).toHaveLength(1);
    expect(result.files[0]?.content).toContain('"extension_version":"2"');
    expect(result.files[0]?.content).toContain('"sql_type":"DECIMAL(18,2)"');
    expect(result.files[0]?.content).toContain('vendor_name: DBT');
    expect(result.files[0]?.content).toContain('vendor_name: CATALOG');

    const imported = importOssieDocuments({
      documents: [{ path: 'sales.yml', content: result.files[0]!.content }],
    });
    expect(imported).toMatchObject({ ok: true, ready: true });
    expect(imported.files.find((file) => file.document.type === 'model')?.document).toMatchObject({
      name: 'completed_orders',
      grain: ['order_id'],
      source: { ref: 'warehouse.raw_orders' },
      where: "raw_orders.status = 'complete'",
      columns: [
        { name: 'order_id', type: 'BIGINT', expr: 'raw_orders.order_id' },
        { name: 'amount', type: 'DECIMAL(18,2)', expr: 'raw_orders.amount' },
      ],
    });
    expect(imported.files.find((file) => file.document.type === 'source')?.document).toMatchObject({
      name: 'raw_orders',
      connection: 'warehouse',
      schema: {
        columns: [
          { name: 'order_id', type: 'BIGINT', primary_key: true },
          { name: 'amount', type: 'DECIMAL(18,2)' },
        ],
      },
    });
    expect(imported.files.find((file) => file.document.type === 'metric')?.document).toMatchObject({
      name: 'completed_revenue',
      model: 'completed_orders',
      expression: 'SUM({completed_orders.amount})',
      datatype: 'Decimal',
      synonyms: ['recognized revenue'],
      tags: ['finance'],
    });
    expect(
      imported.files.find((file) => file.document.type === 'relationship')?.document
    ).toMatchObject({
      name: 'completed_to_raw',
      left_model: 'completed_orders',
      right_model: 'warehouse.raw_orders',
      join_type: 'left',
      relationship_type: 'many_to_one',
    });
  });

  it('keeps external dependencies, omits partial relationships, and blocks strict readiness', () => {
    const result = exportOssieDocument(
      request({
        ossieVersion: '0.2.0.dev0',
        strict: true,
        selection: { selectors: [{ kind: 'model', name: 'completed_orders' }] },
      })
    );

    expect(result).toMatchObject({ ok: true, ready: false });
    const document = result.files[0]?.document as {
      datasets: Array<{ name: string }>;
      metrics: Array<{ name: string }>;
      relationships: Array<{ name: string }>;
    };
    expect(document.datasets.map((dataset) => dataset.name)).toEqual(['completed_orders']);
    expect(document.metrics.map((item) => item.name)).toEqual(['completed_revenue']);
    expect(document.relationships).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['export_dependency_not_selected', 'export_object_partially_selected'])
    );
  });

  it('does not validate unselected invalid models', () => {
    const project = {
      ...request().project,
      models: [
        model,
        {
          spec_version: '0.2',
          type: 'model',
          model_kind: 'agentic',
          name: 'research_orders',
        },
      ],
    };
    const selected = exportOssieDocument(
      request({
        project,
        selection: {
          selectors: [
            { kind: 'source', connection: 'warehouse', name: 'raw_orders' },
            { kind: 'model', name: 'completed_orders' },
          ],
        },
      })
    );

    expect(selected).toMatchObject({ ok: true, ready: true });
    expect(selected.files[0]?.document).toMatchObject({
      semantic_model: [
        {
          datasets: [{ name: 'completed_orders' }, { name: 'raw_orders' }],
        },
      ],
    });

    const all = exportOssieDocument(request({ project, selection: { all: true } }));
    expect(all).toMatchObject({ ok: false, ready: false, files: [] });
  });

  it('exports agentic models as catalog-only datasets', () => {
    const result = exportOssieDocument(
      request({
        ossieVersion: '0.2.0.dev0',
        project: {
          ...request().project,
          models: [agenticModel],
          metrics: [],
          relationships: [],
          addresses: {
            'warehouse.raw_orders': 'ANALYTICS.RAW.RAW_ORDERS',
            researched_orders: '"ANALYTICS"."MART"."RESEARCHED_ORDERS"',
          },
        },
      })
    );

    expect(result).toMatchObject({ ok: true, ready: true });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'catalog_only_export', severity: 'warning' }),
      ])
    );
    const document = result.files[0]?.document as {
      datasets: Array<{
        name: string;
        source: string;
        fields: Array<{ name: string; custom_extensions?: Array<{ data: string }> }>;
        custom_extensions?: Array<{ vendor_name: string }>;
      }>;
    };
    expect(document.datasets[0]).toMatchObject({
      name: 'researched_orders',
      source: '"ANALYTICS"."MART"."RESEARCHED_ORDERS"',
    });
    expect(document.datasets[0]?.fields.map((field) => field.name)).toEqual([
      'order_id',
      'summary',
      '_dogsled_run_id',
      '_dogsled_evidence',
      '_dogsled_confidence',
      '_dogsled_reason',
    ]);
    expect(document.datasets[0]?.custom_extensions ?? []).toEqual([]);
    expect(result.files[0]?.content).not.toContain('build_expression');
    expect(result.files[0]?.content).not.toContain('replace_processed_keys');

    const imported = importOssieDocuments({
      documents: [{ path: 'agentic.yml', content: result.files[0]!.content }],
      context: { connections: { defaultConnection: 'warehouse' } },
    });
    expect(imported).toMatchObject({ ok: true, ready: true });
    expect(imported.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          document: expect.objectContaining({ type: 'source', name: 'researched_orders' }),
        }),
      ])
    );

    expect(
      exportOssieDocument(
        request({
          ossieVersion: '0.2.0.dev0',
          strict: true,
          project: {
            ...request().project,
            models: [agenticModel],
            metrics: [],
            relationships: [],
            addresses: { researched_orders: 'ANALYTICS.MART.RESEARCHED_ORDERS' },
          },
        })
      )
    ).toMatchObject({ ok: true, ready: false, files: expect.any(Array) });
  });

  it('exports flatten_json models as catalog-only datasets', () => {
    const flattened = {
      ...model,
      flatten_json: { column: 'payload', path: 'items', alias: 'item' },
    };
    const result = exportOssieDocument(
      request({
        ossieVersion: '0.2.0.dev0',
        project: { ...request().project, models: [flattened] },
      })
    );

    expect(result).toMatchObject({ ok: true, ready: true });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'catalog_only_export', severity: 'warning' }),
      ])
    );
    const document = result.files[0]?.document as {
      datasets: Array<{
        name: string;
        fields: Array<{ name: string }>;
        custom_extensions?: Array<{ vendor_name: string }>;
      }>;
    };
    const dataset = document.datasets.find((entry) => entry.name === 'completed_orders');
    expect(dataset?.fields.map((field) => field.name)).toEqual(['order_id', 'amount']);
    expect(dataset?.custom_extensions ?? []).toEqual([]);
    expect(result.files[0]?.content).not.toContain('flatten_json');
    expect(result.files[0]?.content).not.toContain('build_expression');

    const imported = importOssieDocuments({
      documents: [{ path: 'flattened.yml', content: result.files[0]!.content }],
      context: { connections: { defaultConnection: 'warehouse' } },
    });
    expect(imported).toMatchObject({ ok: true, ready: true });
    expect(imported.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          document: expect.objectContaining({ type: 'source', name: 'completed_orders' }),
        }),
      ])
    );
  });

  it.each([
    ['many_to_one', 'completed_orders', 'raw_orders'],
    ['one_to_many', 'raw_orders', 'completed_orders'],
    ['one_to_one', 'completed_orders', 'raw_orders'],
    ['many_to_many', 'completed_orders', 'raw_orders'],
  ] as const)('projects %s relationships with the Ossie many side first', (kind, from, to) => {
    const result = exportOssieDocument(
      request({
        ossieVersion: '0.2.0.dev0',
        project: {
          ...request().project,
          relationships: [{ ...relationship, relationship_type: kind }],
        },
      })
    );
    const document = result.files[0]?.document as {
      relationships: Array<{ from: string; to: string }>;
    };
    expect(document.relationships[0]).toMatchObject({ from, to });
    expect(
      result.diagnostics.some((entry) => entry.code === 'relationship_cardinality_projected')
    ).toBe(kind === 'one_to_one' || kind === 'many_to_many');
  });

  it('is deterministic and rejects unsupported wildcard outputs', () => {
    const first = exportOssieDocument(request({ ossieVersion: '0.2.0.dev0' }));
    const reordered = request({ ossieVersion: '0.2.0.dev0' });
    reordered.project.sources.reverse();
    reordered.project.models.reverse();
    reordered.project.metrics.reverse();
    reordered.project.relationships.reverse();
    const second = exportOssieDocument(reordered);
    expect(second).toEqual(first);

    const unsupported = exportOssieDocument(
      request({
        ossieVersion: '0.2.0.dev0',
        project: {
          ...request().project,
          models: [{ ...model, include_all_columns: true }],
        },
        selection: { selectors: [{ kind: 'model', name: 'completed_orders' }] },
      })
    );
    expect(unsupported).toMatchObject({ ok: false, ready: false, files: [] });
    expect(unsupported.diagnostics[0]?.message).toContain('include_all_columns');
  });
  it('leaves out properties Dogsled ignores and warns once per dataset', () => {
    const unionModel = {
      ...model,
      name: 'all_orders',
      union: [
        {
          ref: 'warehouse.raw_orders',
          columns: [
            { name: 'order_id', expr: 'order_id', type: 'BIGINT' },
            { name: 'amount', expr: 'amount', type: 'DECIMAL(18,2)' },
          ],
        },
      ],
    };
    const nullableSource = {
      ...source,
      schema: {
        columns: source.schema.columns.map((column) => ({ ...column, nullable: false })),
      },
    };
    const exportRequest = request({
      ossieVersion: '0.2.0.dev0',
      project: {
        ...request().project,
        sources: [nullableSource],
        models: [model, unionModel],
        addresses: { ...request().project.addresses, all_orders: 'ANALYTICS.MART.ALL_ORDERS' },
      },
    });
    const result = exportOssieDocument(exportRequest);

    expect(result).toMatchObject({ ok: true, ready: true });
    const ignored = result.diagnostics.filter((entry) => entry.code === 'native_property_ignored');
    expect(ignored.map((entry) => [entry.severity, entry.path])).toEqual([
      ['warning', 'project#datasets.all_orders'],
      ['warning', 'project#datasets.raw_orders'],
    ]);
    expect(ignored[0]?.message).toContain('union[*].columns[*].type');
    expect(ignored[1]?.message).toContain('schema.columns[*].nullable');
    expect(result.files[0]?.content).not.toContain('nullable');
    expect(exportOssieDocument({ ...exportRequest, strict: true })).toMatchObject({
      ok: true,
      ready: false,
    });
  });
  it('says a Project with no sources or models has nothing to export', () => {
    const empty = exportOssieDocument(
      request({
        project: { sources: [], models: [], metrics: [], relationships: [], addresses: {} },
      })
    );
    expect(empty).toMatchObject({ ok: false, files: [] });
    expect(empty.diagnostics).toEqual([
      expect.objectContaining({
        code: 'native_incomplete',
        path: 'project#datasets',
        message: 'This Project has no sources or models, so there is nothing to export.',
      }),
    ]);
  });
  it('leaves models with unlisted columns out of a whole-Project export and names them', () => {
    const result = exportOssieDocument(
      request({
        project: {
          ...request().project,
          models: [
            { ...model, include_all_columns: true },
            { ...model, name: 'all_orders', include_all_columns: true },
          ],
        },
      })
    );
    expect(result).toMatchObject({ ok: true });
    const omitted = result.diagnostics.filter((entry) => entry.code === 'native_dataset_omitted');
    expect(omitted).toEqual([
      expect.objectContaining({
        severity: 'warning',
        path: 'project#datasets.all_orders.include_all_columns',
        message:
          'Models all_orders (include_all_columns), completed_orders (include_all_columns) make columns that the Blueprint does not list, so Ossie export cannot describe their fields. The export leaves them out.',
      }),
    ]);
    const content = result.files[0]?.content ?? '';
    expect(content).toContain('name: raw_orders');
    expect(content).not.toContain('completed_orders');
  });
  it('refuses when every dataset has unlisted columns', () => {
    const result = exportOssieDocument(
      request({
        project: {
          ...request().project,
          sources: [],
          relationships: [],
          metrics: [],
          models: [{ ...model, include_all_columns: true }],
        },
      })
    );
    expect(result).toMatchObject({ ok: false, files: [] });
    expect(result.diagnostics.at(-1)?.message).toContain('No other datasets are left to export.');
  });
  it('exports a model with derived columns as its finished dataset', () => {
    const derived = {
      ...model,
      derived_columns: [
        { name: 'amount_cents', expr: 'amount * 100', type: 'BIGINT', description: 'Cents' },
      ],
    };
    const result = exportOssieDocument(
      request({ project: { ...request().project, models: [derived] } })
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'catalog_only_export',
        message: expect.stringContaining('its derived_columns build'),
      })
    );
    const content = result.files[0]?.content ?? '';
    expect(content).toContain('name: amount_cents');
    expect(content).toContain('description: Cents');
  });
  it('names the document and key when input is not plain bounded data', () => {
    const result = exportOssieDocument(
      request({
        project: {
          ...request().project,
          models: [{ ...model, ai_context: { examples: [{ constructor: 'x' }] } }],
        },
      })
    );
    expect(result).toMatchObject({ ok: false, files: [] });
    expect(result.diagnostics[0]?.message).toBe(
      'Input must be bounded JSON data, without cycles or unsafe property keys: project#models.completed_orders at ai_context.examples[0].constructor uses the reserved key constructor.'
    );
  });
  it('exports a model whose YAML aliases share one value in several places', () => {
    const shared = parse(
      `grain: &keys [order_id]\nmaterialization:\n  type: incremental\n  unique_key: *keys\n`
    ) as { grain: string[]; materialization: { type: string; unique_key: string[] } };
    expect(shared.materialization.unique_key).toBe(shared.grain);
    const result = exportOssieDocument(
      request({ project: { ...request().project, models: [{ ...model, ...shared }] } })
    );
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });
  it('exports a Project whose document is larger than 1 MB, up to the 10 MB export limit', () => {
    const project = projectWithLongDescriptions(40, 50_000);
    const result = exportOssieDocument(request({ project }));
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.files[0]?.content ?? '', 'utf8')).toBeGreaterThan(2_000_000);
  });
  it('refuses an export document larger than 10 MB and says so', () => {
    const project = projectWithLongDescriptions(12, 900_000);
    const result = exportOssieDocument(request({ project }));
    expect(result).toMatchObject({ ok: false, files: [] });
    expect(result.diagnostics.find((entry) => entry.severity === 'error')?.message).toMatch(
      /the exported Ossie document at .+ makes the data larger than 10 MB\.$/u
    );
  });
  it('still rejects a value that contains itself and says where', () => {
    const looped: Record<string, unknown> = { note: 'x' };
    looped['again'] = looped;
    const result = exportOssieDocument(
      request({ project: { ...request().project, models: [{ ...model, ai_context: looped }] } })
    );
    expect(result.diagnostics[0]?.message).toBe(
      'Input must be bounded JSON data, without cycles or unsafe property keys: project#models.completed_orders at ai_context.again contains itself.'
    );
  });
});
