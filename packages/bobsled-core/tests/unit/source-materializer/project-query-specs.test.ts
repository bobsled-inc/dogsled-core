import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectQuerySpecLoader } from '../../../src/runtime/source-materializer/project-query-specs.js';

vi.mock('@bobsled-inc/integrations', () => ({ loadQueryableResourceSpecs: vi.fn() }));

let root: string;
const integration = {
  spec_version: '1',
  type: 'integration',
  name: 'fictional_api',
  transport: { type: 'http', base_url: 'https://example.com', auth: { type: 'none' } },
};
const resource = {
  spec_version: '1',
  type: 'resource',
  name: 'records',
  integration: 'fictional_api',
  description: 'Fictional records.',
  api: { endpoint: '/records', method: 'GET' },
  input: { id: { type: 'integer' } },
  query: { filters: { id: { operators: ['eq'], bind: { eq: { input: 'id' } } } } },
  output: { id: { type: 'integer', path: '$.id' } },
  extract: { record_path: '$.data', table: { primary_key: ['id'] } },
};
function write(name: string, document: unknown) {
  const filename = path.join(root, name);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify(document));
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-local-query-'));
  write('integrations/api.yml', integration);
  write('resources/records.yml', resource);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('local Project query resource boundary', () => {
  it('resolves a declared HTTP query without a hosted catalog entry', () => {
    const loaded = projectQuerySpecLoader(root)('fictional_api', 'records');
    expect(loaded?.integration.name).toBe('fictional_api');
    expect(loaded?.resource.name).toBe('records');
  });
  it('does not silently fall back when a local resource is missing', () => {
    expect(() => projectQuerySpecLoader(root)('fictional_api', 'missing')).toThrow(/not found/);
  });
  it('keeps extraction-only resources outside the query surface', () => {
    const { query: _query, ...extractOnly } = resource;
    write('resources/records.yml', extractOnly);
    expect(projectQuerySpecLoader(root)('fictional_api', 'records')).toBeUndefined();
  });
  it('preserves explicit authorization for billable query resources', () => {
    write('resources/records.yml', {
      ...resource,
      billing: {
        mode: 'billable',
        ownership: 'third_party',
        unit: 'request',
        estimation: { model: 'per_request', amount: 1, currency: 'USD' },
        authorization: { requires_plan: true },
      },
    });
    const load = projectQuerySpecLoader(root);
    expect(load('fictional_api', 'records')).toBeUndefined();
    expect(load('fictional_api', 'records', { includeBillable: true })?.resource.name).toBe(
      'records'
    );
  });
});
