import assert from 'node:assert/strict';
import test from 'node:test';

import { GET as getRuns } from '../src/app/api/entity-graph/runs/route';

interface RunsErrorPayload {
  error?: string;
}

test('Entity graph runs rejects unsupported scenarios with a 400', async () => {
  const response = await getRuns(
    new Request('http://localhost/api/entity-graph/runs?scenario=bogus')
  );
  const rawPayload: unknown = await response.json();
  const payload = rawPayload as RunsErrorPayload;

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Unsupported scenario: bogus');
});
