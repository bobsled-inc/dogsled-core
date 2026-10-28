import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  exportOssieDocument,
  exportOssieDocuments,
  importOssieDocuments,
} from '../../src/interchange/index.js';

const source = {
  spec_version: '0.2',
  type: 'source',
  source_type: 'warehouse_table',
  name: 'orders',
  connection: 'warehouse',
  table: 'PUBLIC.ORDERS',
  schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
};
const query = {
  spec_version: '0.2',
  type: 'vq',
  name: 'orders_by_id',
  description: 'Find an order',
  nlq: 'Which order has this ID?',
  sql: 'SELECT * FROM {warehouse.orders} WHERE id = :id',
  connection: 'warehouse',
  tags: ['orders'],
  parameters: [
    { name: 'id', type: 'integer', required: true, default: 1, description: 'Order ID' },
  ],
};
function exported(queries: unknown[] = [query], options = {}) {
  return exportOssieDocument({
    project: {
      sources: [source],
      models: [],
      metrics: [],
      relationships: [],
      verifiedQueries: queries,
      addresses: {},
    },
    semanticModelName: 'sales',
    selection: { all: true },
    ossieVersion: '0.2.0.dev0',
    ...options,
  });
}
function imported(data: unknown, vendor = 'DOGSLED') {
  return importOssieDocuments({
    documents: [
      {
        path: 'queries.yml',
        content: stringify({
          ...exported([]).files[0]!.document,
          custom_extensions: [
            { vendor_name: vendor, data: typeof data === 'string' ? data : JSON.stringify(data) },
          ],
        }),
      },
    ],
  });
}
function queries(result: ReturnType<typeof importOssieDocuments>) {
  return result.files.filter((file) => file.document['type'] === 'vq');
}

describe('OSI verified queries', () => {
  it('exports native query data and restores it as a native file', () => {
    const result = exported();
    expect(result.ok).toBe(true);
    const extension = (
      result.files[0]!.document['custom_extensions'] as Array<{ vendor_name: string; data: string }>
    )[0]!;
    expect(extension.vendor_name).toBe('DOGSLED');
    expect(JSON.parse(extension.data)).toEqual({
      extension_version: '2',
      verified_queries: [query],
    });
    const restored = importOssieDocuments({ documents: result.files });
    expect(restored.ready).toBe(true);
    expect(queries(restored)).toHaveLength(1);
    expect(queries(restored)[0]!.path).toMatch(/^verified_queries\/[a-f0-9]+\.yml$/);
    expect(queries(restored)[0]!.document).toEqual(query);
  });

  it('includes queries through the compatibility export API', () => {
    const result = exportOssieDocuments([
      { path: 'source.yml', document: source },
      { path: 'vq.yml', document: query },
    ]);
    expect(queries(importOssieDocuments({ documents: result.files }))).toHaveLength(1);
  });

  it('omits partly selected queries and reports why', () => {
    const result = exported(
      [{ ...query, sql: 'SELECT * FROM {warehouse.orders} JOIN {customers} USING (id)' }],
      {
        selection: { selectors: [{ kind: 'source', connection: 'warehouse', name: 'orders' }] },
      }
    );
    expect(result.files[0]!.document).not.toHaveProperty('custom_extensions');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'export_object_partially_selected' })
    );
  });

  it('includes queries without tokens only when exporting all', () => {
    const standalone = { ...query, sql: 'SELECT 1' };
    expect(exported([standalone]).files[0]!.document).toHaveProperty('custom_extensions');
    expect(
      exported([standalone], {
        selection: { selectors: [{ kind: 'source', connection: 'warehouse', name: 'orders' }] },
      }).files[0]!.document
    ).not.toHaveProperty('custom_extensions');
  });

  it('warns for 0.1.1 and blocks strict export', () => {
    const result = exported([query], { ossieVersion: '0.1.1', strict: true });
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'verified_queries_not_supported_by_profile' })
    );
  });

  it('rejects duplicate native queries', () => {
    expect(exported([query, query]).ok).toBe(false);
  });

  it.each([
    'not JSON',
    { extension_version: '99', verified_queries: [query] },
    { extension_version: '2', verified_queries: [{ ...query, sql: 4 }] },
    { extension_version: '2', verified_queries: [{ ...query, name: '../escape' }] },
    { extension_version: '2', verified_queries: [query, query] },
    { extension_version: '2', verified_queries: [query], unknown: true },
  ])('rejects invalid owned extensions without returning partial files: %j', (data) => {
    const result = imported(data);
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
  });

  it('does not interpret foreign query extensions', () => {
    const result = imported({ extension_version: '2', verified_queries: [query] }, 'OTHER');
    expect(result.ok).toBe(true);
    expect(queries(result)).toEqual([]);
  });

  it('rejects duplicate query identities across input documents', () => {
    const first = exported().files[0]!;
    const second = exported([{ ...query, sql: 'SELECT 1' }]).files[0]!;
    const document = { ...second.document, datasets: [{ name: 'other', source: 'PUBLIC.OTHER' }] };
    const result = importOssieDocuments({
      documents: [first, { path: 'other.yml', content: stringify(document) }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_identity',
        message: 'Duplicate verified query orders_by_id.',
      })
    );
  });

  it('rebinds query source references through dataset bindings', () => {
    const result = exported();
    const restored = importOssieDocuments({
      documents: result.files,
      context: {
        connections: {
          datasetBindings: [
            { documentPath: result.files[0]!.path, dataset: 'orders', connection: 'target' },
          ],
        },
      },
    });
    expect(queries(restored)[0]!.document).toMatchObject({
      sql: 'SELECT * FROM {target.orders} WHERE id = :id',
      connection: 'target',
    });
  });

  it('gives dataset bindings priority over connection aliases for the query connection', () => {
    const result = exported();
    const restored = importOssieDocuments({
      documents: result.files,
      context: {
        connections: {
          connectionAliases: { warehouse: 'alias' },
          datasetBindings: [
            { documentPath: result.files[0]!.path, dataset: 'orders', connection: 'bound' },
          ],
        },
      },
    });
    expect(restored.ready).toBe(true);
    expect(queries(restored)[0]!.document).toMatchObject({
      connection: 'bound',
      sql: 'SELECT * FROM {bound.orders} WHERE id = :id',
    });
  });

  it('reports missing query references as an incomplete draft', () => {
    const result = imported({
      extension_version: '2',
      verified_queries: [{ ...query, sql: 'SELECT * FROM {missing}' }],
    });
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'native_incomplete',
        path: 'queries.yml#verified_queries.orders_by_id',
      })
    );
  });

  it('rebinds source tokens and connection while preserving SQL literals and comments', () => {
    const result = exported([
      {
        ...query,
        sql: "SELECT '{warehouse.orders}' FROM {warehouse.orders} -- {warehouse.orders}",
      },
    ]);
    const restored = importOssieDocuments({
      documents: result.files,
      context: { connections: { connectionAliases: { warehouse: 'target' } } },
    });
    expect(queries(restored)[0]!.document).toMatchObject({
      connection: 'target',
      sql: "SELECT '{warehouse.orders}' FROM {target.orders} -- {warehouse.orders}",
    });
  });
});
