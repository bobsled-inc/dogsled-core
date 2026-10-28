import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAuthType } from '../src/lib/integration-auth';

test('resolveAuthType falls back to legacy transport specs without transports', () => {
  const authType = resolveAuthType({
    transport: {
      type: 'http',
      auth: { type: 'bearer' },
    },
  } as never);

  assert.equal(authType, 'bearer');
});
