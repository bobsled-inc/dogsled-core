import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { GET as listSpecs } from '../src/app/api/entity-graph/specs/route';
import { GET as getSpec, PUT as putSpec } from '../src/app/api/entity-graph/specs/[name]/route';
import { getEntityGraphSpecsDir } from '../src/lib/entity-graph-workspace';
import type { EntityGraphRouteErrorResponse } from '../src/lib/entity-graph-route-errors';

test('Entity Graph spec list can be filtered to resolution specs for the design surface', async () => {
  const response = await listSpecs(
    new Request('http://localhost/api/entity-graph/specs?type=resolution')
  );
  const payload = (await response.json()) as { specs?: string[] };

  assert.equal(response.status, 200);
  assert.ok(payload.specs?.includes('company_resolution'));
  assert.ok(!payload.specs?.includes('company_survivorship'));
});

test('Entity Graph spec list rejects unsupported type filters', async () => {
  const response = await listSpecs(
    new Request('http://localhost/api/entity-graph/specs?type=bogus')
  );
  const payload = (await response.json()) as { error?: string };

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Unsupported spec type: bogus');
});

test('Entity Graph spec detail rejects survivorship specs on the resolution design surface', async () => {
  const response = await getSpec(
    new Request('http://localhost/api/entity-graph/specs/company_survivorship?type=resolution'),
    {
      params: Promise.resolve({ name: 'company_survivorship' }),
    }
  );
  const payload = (await response.json()) as { error?: string };

  assert.equal(response.status, 409);
  assert.equal(payload.error, 'This surface only supports resolution specs.');
});

test('Entity Graph spec detail rejects unsupported scenario filters with a 400', async () => {
  const response = await getSpec(
    new Request(
      'http://localhost/api/entity-graph/specs/company_resolution?type=resolution&scenario=bogus'
    ),
    {
      params: Promise.resolve({ name: 'company_resolution' }),
    }
  );
  const payload = (await response.json()) as { error?: string };

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Unsupported scenario: bogus');
});

test('Entity Graph spec save rejects overwriting survivorship specs from the resolution design surface', async () => {
  const yaml = await fs.readFile(
    path.join(getEntityGraphSpecsDir(), 'company_resolution.yml'),
    'utf8'
  );
  const response = await putSpec(
    new Request('http://localhost/api/entity-graph/specs/company_survivorship?type=resolution', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml }),
    }),
    {
      params: Promise.resolve({ name: 'company_survivorship' }),
    }
  );
  const payload = (await response.json()) as { error?: string };

  assert.equal(response.status, 409);
  assert.equal(payload.error, 'This surface only supports resolution specs.');
});

test('Entity Graph spec save omits internal file paths from successful responses', async () => {
  const yaml = await fs.readFile(
    path.join(getEntityGraphSpecsDir(), 'company_resolution.yml'),
    'utf8'
  );
  const response = await putSpec(
    new Request('http://localhost/api/entity-graph/specs/company_resolution?type=resolution', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml }),
    }),
    {
      params: Promise.resolve({ name: 'company_resolution' }),
    }
  );
  const payload = (await response.json()) as { ok?: boolean; file?: string };

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.file, undefined);
});

test('Entity Graph spec save returns structured validation details for invalid YAML', async () => {
  const response = await putSpec(
    new Request('http://localhost/api/entity-graph/specs/company_resolution?type=resolution', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        yaml: 'spec_version: "0.2"\nname: customer_resolution\ntype: resolution\nblocking: [',
      }),
    }),
    {
      params: Promise.resolve({ name: 'company_resolution' }),
    }
  );
  const payload = (await response.json()) as EntityGraphRouteErrorResponse;

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Invalid YAML');
  assert.equal(payload.code, 'invalid_yaml');
  assert.match(payload.detail ?? '', /flow sequence|unexpected end/i);
});

test('Entity Graph spec save always returns JSON when writing the file throws', async () => {
  const specPath = path.join(getEntityGraphSpecsDir(), 'company_resolution.yml');
  const yaml = await fs.readFile(specPath, 'utf8');
  const backupPath = `${specPath}.backup`;

  try {
    // Replace the spec file with a same-named directory so fs.rename(tmpPath → file) fails with EISDIR.
    await fs.rename(specPath, backupPath);
    await fs.mkdir(specPath);

    const response = await putSpec(
      new Request('http://localhost/api/entity-graph/specs/company_resolution', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml }),
      }),
      {
        params: Promise.resolve({ name: 'company_resolution' }),
      }
    );
    const payload = (await response.json()) as EntityGraphRouteErrorResponse;

    assert.equal(response.status, 500);
    assert.equal(payload.error, 'Failed to write spec');
    assert.equal(payload.code, 'write_failed');
    assert.match(payload.detail ?? '', /persist this spec/i);
  } finally {
    const cleanupErrors: unknown[] = [];
    await fs.rm(specPath, { recursive: true, force: true }).catch((err) => {
      cleanupErrors.push(err);
    });
    await fs.rename(backupPath, specPath).catch((err) => {
      cleanupErrors.push(err);
    });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to restore Entity Graph spec fixture');
    }
  }
});
