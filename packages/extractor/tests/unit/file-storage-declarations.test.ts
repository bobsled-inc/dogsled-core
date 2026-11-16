import * as s3Sdk from '@aws-sdk/client-s3';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileStorageClient } from '../../src/runtime/file-storage-client.js';
import { IntegrationSpecSchema } from '../../src/framework/extractor/resource.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('file storage declarations', () => {
  it('only sends declared credentials to a custom S3 endpoint', async () => {
    const tokens: unknown[] = [];
    const server = createServer((request, response) => {
      tokens.push(request.headers['x-amz-security-token']);
      response.statusCode = 204;
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    vi.stubEnv('BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS', '1');
    vi.stubEnv('TEST_S3_ID', 'local-id');
    vi.stubEnv('TEST_S3_KEY', 'local-key');
    vi.stubEnv('TEST_S3_SESSION', 'local-session-canary');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      const source = {
        spec_version: '1',
        type: 'integration',
        name: 'custom_s3',
        source_type: 's3',
        connection: {
          bucket: 'test',
          region: 'us-east-1',
          endpoint: `http://127.0.0.1:${address.port}`,
          force_path_style: true,
        },
        auth: {
          type: 'static_env',
          access_key_id_env: 'TEST_S3_ID',
          secret_access_key_env: 'TEST_S3_KEY',
          session_token_env: 'TEST_S3_SESSION',
        },
        auth_env_vars: ['TEST_S3_ID', 'TEST_S3_KEY'],
      };
      await expect(createFileStorageClient(IntegrationSpecSchema.parse(source))).rejects.toThrow(
        'Add TEST_S3_SESSION to auth_env_vars'
      );
      expect(tokens).toEqual([]);
      await expect(
        createFileStorageClient(
          IntegrationSpecSchema.parse({ ...source, auth: { type: 'default_chain' } })
        )
      ).rejects.toThrow('Custom S3 endpoints require static_env');
      expect(tokens).toEqual([]);
      vi.spyOn(globalThis, 'Function').mockImplementationOnce(function () {
        return async () => s3Sdk;
      });
      const client = await createFileStorageClient(
        IntegrationSpecSchema.parse({
          ...source,
          auth_env_vars: [...source.auth_env_vars, 'TEST_S3_SESSION'],
        })
      );
      try {
        for await (const file of client.list({ path: '*' })) void file;
        expect(tokens).toEqual(['local-session-canary']);
      } finally {
        await client.close?.();
      }
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it.each([
    {
      source_type: 'sftp',
      connection: {
        host: 'example.com',
        username: 'test',
        base_directory: '/',
        host_keys: [
          {
            algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
        ],
      },
      auth: { type: 'password', password_env: 'CANARY' },
    },
    {
      source_type: 'gcs',
      connection: { bucket: 'test' },
      auth: { type: 'service_account_json', credentials_json_env: 'CANARY' },
    },
  ])('rejects undeclared $source_type credentials before loading the provider', async (source) => {
    const integration = IntegrationSpecSchema.parse({
      spec_version: '1',
      type: 'integration',
      name: 'test',
      ...source,
    });
    await expect(createFileStorageClient(integration)).rejects.toThrow(
      'Add CANARY to auth_env_vars'
    );
  });
});
