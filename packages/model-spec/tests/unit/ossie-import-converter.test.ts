import { describe, expect, it } from 'vitest';

import { exportOssieDocuments, importOssieDocuments } from '../../src/interchange/index.js';

const source011 = `
version: 0.1.1
semantic_model:
  - name: sales
    description: Sales model
    datasets:
      - name: orders
        source: analytics.public.orders
        primary_key: [id]
        unique_keys: [[id]]
        fields:
          - name: id
            expression:
              dialects:
                - dialect: ANSI_SQL
                  expression: id
`;

const derivedDev = `
version: 0.2.0.dev0
name: sales
datasets:
  - name: orders
    source: analytics.sales.orders
    description: Clean orders
    fields:
      - name: id
        datatype: Integer
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: id
        custom_extensions:
          - vendor_name: DOGSLED
            data: '{"sql_type":"BIGINT","build_expression":"id"}'
    custom_extensions:
      - vendor_name: DOGSLED
        data: '{"extension_version":"2","kind":"derived","grain":["id"],"build":{"source":{"ref":"warehouse.raw_orders"},"materialization":{"type":"table"}}}'
`;

const derivedDatasetExtension =
  '{"extension_version":"2","kind":"derived","grain":["id"],"build":{"source":{"ref":"warehouse.raw_orders"},"materialization":{"type":"table"}}}';

const semanticDev = `
version: 0.2.0.dev0
name: sales
datasets:
  - name: customers
    source: analytics.sales.customers
    ai_context: {owner: sales}
    fields:
      - name: id
        datatype: Integer
        dimension: {is_time: true}
        ai_context: {synonyms: [customer_key]}
        expression:
          dialects: [{dialect: ANSI_SQL, expression: id}]
        custom_extensions:
          - vendor_name: DOGSLED
            data: '{"sql_type":"BIGINT"}'
          - vendor_name: CATALOG
            data: 'keep field data'
    custom_extensions:
      - vendor_name: DOGSLED
        data: '{"extension_version":"2","kind":"source","source_type":"warehouse_table","connection":"warehouse"}'
      - vendor_name: DBT
        data: '{"materialized":"table"}'
      - vendor_name: TRACK
        data: '{"legacy":true}'
  - name: orders
    source: analytics.sales.orders
    fields:
      - name: customer_id
        datatype: Integer
        expression:
          dialects: [{dialect: ANSI_SQL, expression: customer_id}]
        custom_extensions:
          - vendor_name: DOGSLED
            data: '{"sql_type":"BIGINT"}'
      - name: amount
        datatype: Decimal
        expression:
          dialects: [{dialect: ANSI_SQL, expression: amount}]
        custom_extensions:
          - vendor_name: DOGSLED
            data: '{"sql_type":"DECIMAL(18,2)"}'
    custom_extensions:
      - vendor_name: DOGSLED
        data: '{"extension_version":"2","kind":"source","source_type":"warehouse_table","connection":"warehouse"}'
metrics:
  - name: revenue
    datatype: Decimal
    expression:
      dialects: [{dialect: ANSI_SQL, expression: "SUM({orders.amount})"}]
    custom_extensions:
      - vendor_name: DOGSLED
        data: '{"extension_version":"2","datasets":["orders"],"expression":"SUM({warehouse.orders.amount})"}'
      - vendor_name: CATALOG
        data: 'keep metric data'
relationships:
  - name: orders_to_customers
    from: orders
    to: customers
    from_columns: [customer_id]
    to_columns: [id]
    custom_extensions:
      - vendor_name: DOGSLED
        data: '{"extension_version":"2","left_side":"from","relationship_type":"many_to_one","join_type":"left"}'
      - vendor_name: CATALOG
        data: 'keep relationship data'
`;

describe('Ossie import converter', () => {
  it('imports a 0.1.1 dataset as a repairable source draft', () => {
    const result = importOssieDocuments({
      documents: [{ path: 'sales.yml', content: source011 }],
    });

    expect(result.ok).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.document).toMatchObject({
      type: 'source',
      name: 'orders',
      table: 'analytics.public.orders',
      schema: {
        columns: [
          {
            name: 'id',
            primary_key: true,
            semantic_expression: {
              dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }],
            },
          },
        ],
      },
    });
    expect(result.files.some((file) => file.path.startsWith('interchange/'))).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'connection_required',
        'physical_type_required',
        'semantic_model_metadata_not_preserved',
        'unique_keys_not_preserved',
      ])
    );
    expect(result.diagnostics[0]).toMatchObject({
      objectReference: { documentPath: 'sales.yml' },
    });
    expect(result.diagnostics[0]?.remedy).toEqual(expect.any(String));
  });

  it('imports a complete 0.2.0.dev0 derived model with DOGSLED version 2 data', () => {
    const result = importOssieDocuments({
      documents: [{ path: 'sales.yml', content: derivedDev }],
    });

    expect(result.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.document).toMatchObject({
      type: 'model',
      name: 'orders',
      grain: ['id'],
      source: { ref: 'warehouse.raw_orders' },
      columns: [
        {
          name: 'id',
          type: 'BIGINT',
          expr: 'id',
          semantic_expression: {
            dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }],
          },
        },
      ],
    });

    const legacy = importOssieDocuments({
      documents: [
        {
          path: 'legacy.yml',
          content: derivedDev.replace('extension_version":"2', 'extension_version":"1'),
        },
      ],
    });
    expect(legacy).toMatchObject({ ok: true, ready: true });

    const sourceWithoutKind = importOssieDocuments({
      documents: [
        {
          path: 'source.yml',
          content: semanticDev.replaceAll('"kind":"source",', ''),
        },
      ],
    });
    expect(sourceWithoutKind).toMatchObject({ ok: true, ready: true });
    expect(sourceWithoutKind.files.filter((file) => file.document.type === 'source')).toHaveLength(
      2
    );
  });

  it('uses supplied source context to complete a source', () => {
    const result = importOssieDocuments({
      documents: [
        {
          path: 'sales.yml',
          content: source011,
        },
      ],
      context: {
        connections: {
          defaultConnection: 'unused',
          datasetBindings: [
            { documentPath: 'sales.yml', dataset: 'orders', connection: 'warehouse' },
          ],
        },
        physicalSchemas: [
          {
            documentPath: 'sales.yml',
            dataset: 'orders',
            connection: 'warehouse',
            source: 'analytics.public.orders',
            dialect: 'duckdb',
            columns: [{ name: 'id', sqlType: 'BIGINT' }],
          },
        ],
      },
    });

    expect(result.ready).toBe(true);
    expect(result.files[0]?.document).toMatchObject({
      connection: 'warehouse',
      schema: { columns: [{ name: 'id', type: 'BIGINT' }] },
    });
  });

  it('fails an invalid document without returning partial files', () => {
    const result = importOssieDocuments({
      documents: [{ path: 'bad.yml', content: 'version: 0.1.1\nsemantic_model: nope\n' }],
    });

    expect(result).toMatchObject({ ok: false, ready: false, files: [] });
    expect(result.diagnostics[0]?.code).toBe('invalid_ossie_document');

    const malformedExtension = importOssieDocuments({
      documents: [
        {
          path: 'bad-extension.yml',
          content: derivedDev.replace(
            `data: '{"extension_version":"2","kind":"derived","grain":["id"],"build":{"source":{"ref":"warehouse.raw_orders"},"materialization":{"type":"table"}}}'`,
            `data: 'not-json'`
          ),
        },
      ],
    });
    expect(malformedExtension).toMatchObject({ ok: false, ready: false, files: [] });
    expect(malformedExtension.diagnostics.at(-1)?.code).toBe('invalid_bobsled_extension');

    const invalidKind = importOssieDocuments({
      documents: [
        {
          path: 'bad-kind.yml',
          content: derivedDev.replace('"kind":"derived"', '"kind":"agentic"'),
        },
      ],
    });
    expect(invalidKind).toMatchObject({ ok: false, ready: false, files: [] });
    expect(invalidKind.diagnostics.at(-1)?.code).toBe('unsupported_kind');

    const unsafeExtension = importOssieDocuments({
      documents: [
        {
          path: 'unsafe.yml',
          content: derivedDev.replace(
            /data: '\{"extension_version":"2"[^\n]+/,
            `data: '{"__proto__":{}}'`
          ),
        },
      ],
    });
    expect(unsafeExtension).toMatchObject({ ok: false, ready: false, files: [] });
    expect(unsafeExtension.diagnostics.at(-1)?.code).toBe('invalid_bobsled_extension');
  });

  it.each([
    [
      'metadata deeper than 40 levels',
      () => {
        const value: Record<string, unknown> = {};
        let current = value;
        for (let depth = 0; depth < 41; depth += 1) {
          const child: Record<string, unknown> = {};
          current['child'] = child;
          current = child;
        }
        return value;
      },
    ],
    ['metadata with more than 100,000 nodes', () => ({ values: Array(100_000).fill(null) })],
  ])('rejects %s in a DOGSLED extension', (_name, value) => {
    const result = importOssieDocuments({
      documents: [
        {
          path: 'bounded.yml',
          content: derivedDev.replace(derivedDatasetExtension, JSON.stringify(value())),
        },
      ],
    });

    expect(result).toMatchObject({ ok: false, ready: false, files: [] });
    expect(result.diagnostics.at(-1)).toMatchObject({
      code: 'invalid_bobsled_extension',
      severity: 'error',
    });
    expect(result.diagnostics.at(-1)?.message).toContain('bounded JSON object');
  });

  it('imports native metrics, relationships, and owner extensions', () => {
    const result = importOssieDocuments({
      documents: [{ path: 'semantic.yml', content: semanticDev }],
    });

    expect(result).toMatchObject({ ok: true, ready: true });
    const metric = result.files.find((file) => file.document.type === 'metric')?.document;
    expect(metric).toMatchObject({
      name: 'revenue',
      model: 'warehouse.orders',
      expression: 'SUM({warehouse.orders.amount})',
      datatype: 'Decimal',
      interchange: {
        ossie: {
          custom_extensions: [{ vendor_name: 'CATALOG', data: 'keep metric data' }],
        },
      },
    });
    const relationship = result.files.find(
      (file) => file.document.type === 'relationship'
    )?.document;
    expect(relationship).toMatchObject({
      name: 'orders_to_customers',
      left_model: 'warehouse.orders',
      right_model: 'warehouse.customers',
      join_columns: [{ left: 'customer_id', right: 'id' }],
      join_type: 'left',
      relationship_type: 'many_to_one',
      interchange: {
        ossie: {
          custom_extensions: [{ vendor_name: 'CATALOG', data: 'keep relationship data' }],
        },
      },
    });
    const customers = result.files.find((file) => file.document.name === 'customers')?.document;
    const idColumn = (customers?.['schema'] as { columns: Record<string, unknown>[] }).columns[0];
    expect(idColumn).not.toHaveProperty('ai_context');
    expect(customers).toMatchObject({
      ai_context: { owner: 'sales' },
      schema: {
        columns: [
          {
            name: 'id',
            is_time: true,
            synonyms: ['customer_key'],
          },
        ],
      },
      interchange: {
        ossie: {
          custom_extensions: [
            { vendor_name: 'DBT', data: '{"materialized":"table"}' },
            { vendor_name: 'TRACK', data: '{"legacy":true}' },
          ],
          fields: [
            {
              field: 'id',
              custom_extensions: [{ vendor_name: 'CATALOG', data: 'keep field data' }],
            },
          ],
        },
      },
    });
    expect(result.diagnostics.some((entry) => entry.code === 'legacy_vendor')).toBe(true);

    const rebound = importOssieDocuments({
      documents: [{ path: 'semantic.yml', content: semanticDev }],
      context: { connections: { connectionAliases: { warehouse: 'production' } } },
    });
    expect(rebound.files.find((file) => file.document.name === 'orders')?.document).toMatchObject({
      connection: 'production',
    });
    expect(rebound.files.find((file) => file.document.type === 'metric')?.document).toMatchObject({
      model: 'production.orders',
      expression: 'SUM({production.orders.amount})',
    });

    const plainRelationship = importOssieDocuments({
      documents: [
        {
          path: 'plain-relationship.yml',
          content: semanticDev.replace(
            `      - vendor_name: DOGSLED
        data: '{"extension_version":"2","left_side":"from","relationship_type":"many_to_one","join_type":"left"}'
`,
            ''
          ),
        },
      ],
    });
    expect(
      plainRelationship.files.find((file) => file.document.type === 'relationship')?.document
    ).toMatchObject({ join_type: 'inner', relationship_type: 'many_to_one' });
    expect(
      plainRelationship.diagnostics.some(
        (entry) => entry.code === 'relationship_join_type_defaulted'
      )
    ).toBe(true);
  });

  it('re-exports native semantic field properties as standard Ossie fields', () => {
    const roundTripDocument = derivedDev
      .replace(
        'description: Clean orders',
        'description: Clean orders\n    ai_context: {owner: sales}'
      )
      .replace(
        'datatype: Integer',
        'datatype: Integer\n        dimension: {is_time: true}\n        ai_context: {synonyms: [order_key]}'
      );
    const imported = importOssieDocuments({
      documents: [{ path: 'semantic.yml', content: roundTripDocument }],
    });
    const exported = exportOssieDocuments(imported.files, {
      addresses: { orders: 'analytics.sales.orders' },
    });

    expect(exported.diagnostics.map((entry) => entry.code)).toEqual([
      'export_dependency_not_selected',
    ]);
    expect(exported).toMatchObject({ ok: true, ready: true });
    const document = exported.files[0]?.document as {
      datasets: Array<{
        name: string;
        ai_context?: unknown;
        fields: Array<{
          name: string;
          expression?: unknown;
          dimension?: unknown;
          ai_context?: unknown;
        }>;
      }>;
    };
    const orders = document.datasets.find((dataset) => dataset.name === 'orders');
    expect(orders).toMatchObject({ ai_context: { owner: 'sales' } });
    expect(orders?.fields[0]).toMatchObject({
      expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }] },
      dimension: { is_time: true },
      ai_context: { synonyms: ['order_key'] },
    });
  });

  it('keeps safe strict previews but blocks readiness', () => {
    const result = importOssieDocuments({
      documents: [{ path: 'sales.yml', content: derivedDev }],
      options: { strict: true },
    });

    expect(result.ok).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.diagnostics.some((entry) => entry.severity === 'warning')).toBe(true);
  });

  it('fails a duplicate native identity atomically', () => {
    const result = importOssieDocuments({
      documents: [
        { path: 'one.yml', content: derivedDev },
        { path: 'two.yml', content: derivedDev },
      ],
    });

    expect(result).toMatchObject({ ok: false, ready: false, files: [] });
    expect(result.diagnostics.at(-1)?.code).toBe('duplicate_identity');
  });

  it('returns a repairable draft when physical type evidence conflicts', () => {
    const source = derivedDev
      .replace('"kind":"derived"', '"kind":"source","connection":"warehouse"')
      .replace(
        ',"grain":["id"],"build":{"source":{"ref":"warehouse.raw_orders"},"materialization":{"type":"table"}}',
        ''
      )
      .replace(',"build_expression":"id"', '');
    const result = importOssieDocuments({
      documents: [{ path: 'sales.yml', content: source }],
      context: {
        physicalSchemas: [
          {
            documentPath: 'sales.yml',
            dataset: 'orders',
            connection: 'warehouse',
            source: 'analytics.sales.orders',
            dialect: 'duckdb',
            columns: [{ name: 'id', sqlType: 'DOUBLE' }],
          },
        ],
      },
    });

    expect(result).toMatchObject({ ok: true, ready: false });
    expect(result.files).toHaveLength(1);
    expect(result.diagnostics.some((entry) => entry.code === 'physical_type_conflict')).toBe(true);
  });
});
