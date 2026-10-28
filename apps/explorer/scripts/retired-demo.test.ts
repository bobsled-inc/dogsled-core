import assert from 'node:assert/strict';
import test from 'node:test';

import { POST as queryPost } from '../src/app/api/query/route';
import {
  listEntityGraphScenarioDefinitions,
  resolveEntityGraphScenarioEntity,
} from '../src/lib/entity-graph-scenarios';

test('the default sandbox remains available and unregistered demos are rejected', () => {
  assert.deepEqual(
    listEntityGraphScenarioDefinitions().map((scenario) => scenario.id),
    ['default']
  );
  assert.equal(resolveEntityGraphScenarioEntity('default', 'company').scenarioId, 'default');
  assert.throws(
    () => resolveEntityGraphScenarioEntity('retired-demo', 'company'),
    /Unsupported Entity Graph scenario/
  );
});

test('query rejects special database keys before invoking the CLI', async () => {
  const response = await queryPost(
    new Request('http://localhost/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dbKey: 'retired-demo', sql: 'SELECT 1' }),
    })
  );
  assert.equal(response.status, 400);
});

test('query preserves project path containment after removing the special key', async () => {
  const response = await queryPost(
    new Request('http://localhost/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dbPath: '../outside.db', sql: 'SELECT 1' }),
    })
  );
  assert.equal(response.status, 400);
});
