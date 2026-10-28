import { createServer } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { interpolateSecrets } from '../../../src/secrets/interpolate.js';
import { EnvSecretResolver } from '../../../src/secrets/env-resolver.js';
import { buildPostgresRunner } from '../../../src/runtime/runners/postgres.js';
import { PostgresIntegrationSchema } from '../../../src/schemas/integration.js';

describe('database environment declarations', () => {
  it.each(['${{ env.CANARY }}', 'legacy'])(
    'rejects undeclared %s before calling the resolver',
    async (shape) => {
      const resolve = vi.fn(async () => 'must-not-read');
      const value = shape === 'legacy' ? { password_env: 'CANARY' } : { password: shape };
      await expect(interpolateSecrets(value, { resolve })).rejects.toThrow(
        'Add CANARY to auth_env_vars'
      );
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it('only sends a declared password to a PostgreSQL cleartext-auth listener', async () => {
    const received: string[] = [];
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      let started = false;
      socket.on('error', () => {});
      socket.on('data', (data) => {
        if (!started) {
          started = true;
          socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 3]));
        } else {
          received.push(data.subarray(5, -1).toString());
          socket.destroy();
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      const integration = PostgresIntegrationSchema.parse({
        spec_version: '1',
        type: 'integration',
        name: 'canary',
        source_type: 'postgres',
        connection: {
          host: '127.0.0.1',
          port: address.port,
          database: 'test',
          ssl: { mode: 'disable' },
        },
        auth: { type: 'password', user: 'test', password: '${{ env.CANARY }}' },
      });
      const resolver = new EnvSecretResolver({ CANARY: 'local-regression-canary' });
      const connect = async (auth_env_vars: string[]) => {
        const resolved = await interpolateSecrets({ ...integration, auth_env_vars }, resolver);
        await buildPostgresRunner(resolved);
      };
      await expect(connect([])).rejects.toThrow('Add CANARY to auth_env_vars');
      expect(connections).toBe(0);
      expect(received).toEqual([]);
      await expect(connect(['CANARY'])).rejects.toThrow();
      expect(connections).toBe(1);
      expect(received).toEqual(['local-regression-canary']);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
