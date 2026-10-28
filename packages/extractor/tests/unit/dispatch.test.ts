import { describe, expect, it } from 'vitest';

import type { IntegrationSpec, ResourceSpec } from '../../src/types/index.js';
import {
  assertExhaustive,
  classifySourceKind,
  dispatchSourceKind,
} from '../../src/runtime/dispatch.js';

// Minimal in-memory fixtures cast to the public types. The classifier inspects only
// `source_type`, the shape of `source`, and the resource-side type predicates — so we
// don't need to satisfy the full integration schema for these dispatch-only tests.
const fileIntegration = { source_type: 's3' } as unknown as IntegrationSpec;
const warehouseIntegration = { source_type: 'snowflake' } as unknown as IntegrationSpec;
const apiIntegration = { transport: { type: 'http' } } as unknown as IntegrationSpec;

const fileStructuredResource = {
  spec_version: '1',
  type: 'resource',
  name: 'events',
  source: { path: 'exports/*.csv', format: 'csv' },
} as unknown as ResourceSpec;

const fileDocumentResource = {
  spec_version: '1',
  type: 'resource',
  name: 'docs',
  source: { path: 'pdfs/**/*', format: 'document', kind: 'document' },
} as unknown as ResourceSpec;

// Regression coverage for the user-facing `format: document` alias (no explicit `kind`).
// Per the Resource Grammar Contract, the alias must classify identically to
// `kind: document`.
const fileDocumentAliasResource = {
  spec_version: '1',
  type: 'resource',
  name: 'docs_alias',
  source: { path: 'pdfs/**/*', format: 'document' },
} as unknown as ResourceSpec;

const warehouseResource = {
  spec_version: '1',
  type: 'resource',
  name: 'orders',
  source: { table: 'orders', schema: 'public' },
} as unknown as ResourceSpec;

const apiResource = {
  spec_version: '1',
  type: 'resource',
  name: 'customers',
  api: { endpoint: '/v1/customers' },
} as unknown as ResourceSpec;

const lookupOnlyResource = {
  type: 'resource',
  name: 'customer',
  lookup: {
    description: 'Find one customer',
    api: { endpoint: '/v1/customers/${{ input.id }}', method: 'GET' },
    input: { id: { type: 'string', required: true } },
  },
  output: { id: { type: 'string', path: '$.id' } },
} as unknown as ResourceSpec;

describe('classifySourceKind', () => {
  it('classifies file storage with csv format as file_storage_structured', () => {
    expect(classifySourceKind(fileIntegration, fileStructuredResource)).toBe(
      'file_storage_structured'
    );
  });

  it('classifies file storage with kind: document as file_storage_document', () => {
    expect(classifySourceKind(fileIntegration, fileDocumentResource)).toBe('file_storage_document');
  });

  it('classifies file storage with format: document alias (no kind) as file_storage_document', () => {
    expect(classifySourceKind(fileIntegration, fileDocumentAliasResource)).toBe(
      'file_storage_document'
    );
  });

  it('classifies warehouse integrations as warehouse', () => {
    expect(classifySourceKind(warehouseIntegration, warehouseResource)).toBe('warehouse');
  });

  it('falls through to api for transport-based integrations', () => {
    expect(classifySourceKind(apiIntegration, apiResource)).toBe('api');
  });

  it('keeps lookup-only Resources out of extraction dispatch', () => {
    expect(classifySourceKind(apiIntegration, lookupOnlyResource)).toBe('lookup_only');
  });

  it('rejects a lookup-only Resource at the extraction dispatch boundary', async () => {
    await expect(
      dispatchSourceKind({
        integration: apiIntegration,
        resource: lookupOnlyResource,
      } as never)
    ).rejects.toThrow('only supports lookup and cannot be extracted');
  });
});

describe('assertExhaustive', () => {
  it('throws when reached at runtime', () => {
    expect(() => assertExhaustive('unexpected' as never)).toThrow(
      'Unhandled source_kind variant: unexpected'
    );
  });
});
