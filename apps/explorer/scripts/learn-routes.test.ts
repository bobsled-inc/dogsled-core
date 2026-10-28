import assert from 'node:assert/strict';
import test from 'node:test';
import { GET as getCredentials } from '../src/app/api/learn/credentials/route';
import { GET as getTableSample } from '../src/app/api/learn/entity-graph/table/route';

test('Learn credentials route returns presence only for whitelisted env vars', async () => {
  const original = process.env['MCP_SERVER_URL'];
  process.env['MCP_SERVER_URL'] = 'https://example.invalid';
  try {
    const response = await getCredentials(
      new Request('http://localhost/api/learn/credentials?module=mcp-extraction')
    );
    const payload = (await response.json()) as {
      credentials?: Array<{ name: string; present: boolean; value?: string }>;
    };

    assert.equal(response.status, 200);
    assert.ok(payload.credentials?.some((credential) => credential.name === 'MCP_SERVER_URL'));
    assert.ok(payload.credentials?.every((credential) => !('value' in credential)));
  } finally {
    if (original === undefined) {
      delete process.env['MCP_SERVER_URL'];
    } else {
      process.env['MCP_SERVER_URL'] = original;
    }
  }
});

test('Learn credentials route rejects unsupported modules', async () => {
  const response = await getCredentials(
    new Request('http://localhost/api/learn/credentials?module=bogus')
  );
  const payload = (await response.json()) as { code?: string };

  assert.equal(response.status, 400);
  assert.equal(payload.code, 'invalid_request');
});

test('Learn Entity Graph table sample route validates scenario, entity, and suffix', async () => {
  const badScenario = await getTableSample(
    new Request(
      'http://localhost/api/learn/entity-graph/table?scenario=bogus&entity=company&suffix=__review_queue'
    )
  );
  assert.equal(badScenario.status, 400);

  const badEntity = await getTableSample(
    new Request(
      'http://localhost/api/learn/entity-graph/table?scenario=default&entity=location&suffix=__review_queue'
    )
  );
  assert.equal(badEntity.status, 400);

  const badSuffix = await getTableSample(
    new Request(
      'http://localhost/api/learn/entity-graph/table?scenario=default&entity=company&suffix=__raw'
    )
  );
  assert.equal(badSuffix.status, 400);
});
