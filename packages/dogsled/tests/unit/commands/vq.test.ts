import { describe, expect, it, vi } from 'vitest';

import { runVqCommand } from '../../../src/commands/vq.js';

describe('runVqCommand', () => {
  it('passes params and session context through to query execution', async () => {
    const runQueryCommandImpl = vi.fn().mockResolvedValue({
      rows: [],
      receipts: [],
      totalMs: 1,
    });

    await runVqCommand({
      projectRoot: '/tmp/project',
      name: 'open-for-tenant',
      params: { status: 'open' },
      session: { tenant: 'acme', region: 'us-east' },
      loadVqsImpl: async () =>
        new Map([
          [
            'open-for-tenant',
            {
              name: 'open-for-tenant',
              sql: 'SELECT * FROM {github.issues}',
              parameters: [{ name: 'status', type: 'string' }],
            } as never,
          ],
        ]),
      loadApiResourceEntriesImpl: async () =>
        [
          {
            kind: 'api_resource',
            fqRef: 'sources.issues',
            integration: 'github',
            resource: 'issues',
            connection: 'github_prod',
            columns: [{ name: 'id', type: 'integer' }],
          },
        ] as never,
      runQueryCommandImpl,
    });

    expect(runQueryCommandImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: 'SELECT * FROM sources.issues',
        sourceFilterParams: {
          params: { status: 'open' },
          session: { tenant: 'acme', region: 'us-east' },
        },
      })
    );
  });
});
