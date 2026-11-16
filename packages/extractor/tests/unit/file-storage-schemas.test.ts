import { describe, expect, it } from 'vitest';

import { IntegrationSpecSchema, ResourceSpecSchema } from '../../src/framework/extractor/index.js';
import { isWarehouseSource, isWarehouseResource } from '../../src/runtime/warehouse-extractor.js';
import { isFileStorageSource } from '../../src/runtime/file-storage-extractor.js';

const baseResource = {
  spec_version: '1',
  type: 'resource',
  name: 'events',
  source: {
    path: 'exports/*.csv',
    format: 'csv',
  },
  replication: {
    method: 'incremental_append',
    cursor: { field: 'last_modified' },
  },
  output: {
    id: { type: 'string' },
  },
};

describe('file storage schemas', () => {
  it('validates supported provider integrations', () => {
    const integrations = [
      {
        auth_env_vars: ['BUCKET'],
        spec_version: '1',
        type: 'integration',
        name: 's3_exports',
        source_type: 's3',
        connection: { bucket: '${{ env.BUCKET }}', region: 'us-east-1' },
        auth: { type: 'default_chain' },
      },
      {
        auth_env_vars: ['BUCKET'],
        spec_version: '1',
        type: 'integration',
        name: 'gcs_exports',
        source_type: 'gcs',
        connection: { bucket: '${{ env.BUCKET }}' },
        auth: { type: 'adc' },
      },
      {
        auth_env_vars: ['SFTP_HOST', 'SFTP_PASS', 'SFTP_USER'],
        spec_version: '1',
        type: 'integration',
        name: 'sftp_exports',
        source_type: 'sftp',
        connection: {
          host: '${{ env.SFTP_HOST }}',
          username: '${{ env.SFTP_USER }}',
          base_directory: '/exports',
          host_keys: [
            {
              algorithm: 'ssh-rsa',
              fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            },
          ],
        },
        auth: {
          type: 'password',
          password_env: 'SFTP_PASS',
        },
      },
      {
        spec_version: '1',
        type: 'integration',
        name: 'local_exports',
        source_type: 'local',
        connection: { base_directory: 'tests/fixtures/file-storage' },
        auth: { type: 'none' },
      },
      {
        auth_env_vars: ['BLOB_ORIGIN', 'BLOB_URL'],
        spec_version: '1',
        type: 'integration',
        name: 'private_upload',
        source_type: 'vercel_blob',
        connection: { blob_ref: 'attachment-123' },
        auth: {
          type: 'signed_url_env',
          url_env: 'BLOB_URL',
          origin_env: 'BLOB_ORIGIN',
        },
      },
    ];

    for (const integration of integrations) {
      const parsed = IntegrationSpecSchema.safeParse(integration);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(isFileStorageSource(parsed.data)).toBe(true);
        expect(isWarehouseSource(parsed.data)).toBe(false);
      }
    }
  });

  it('rejects invalid provider configs and unsafe file paths', () => {
    const invalidSpecs = [
      {
        spec_version: '1',
        type: 'integration',
        name: 'bad_s3',
        source_type: 's3',
        connection: { bucket: 'exports' },
        auth: { type: 'default_chain' },
      },
      {
        auth_env_vars: ['PASS'],
        spec_version: '1',
        type: 'integration',
        name: 'bad_sftp',
        source_type: 'sftp',
        connection: { host: 'example.com', username: 'me', base_directory: '/exports' },
        auth: { type: 'password', password_env: 'PASS' },
      },
      {
        ...baseResource,
        source: { path: '../secrets/*.csv', format: 'csv' },
      },
      {
        ...baseResource,
        source: { path: '/absolute/*.csv', format: 'csv' },
      },
      {
        auth_env_vars: ['BLOB_ORIGIN', 'BLOB_URL'],
        spec_version: '1',
        type: 'integration',
        name: 'unsafe_private_upload',
        source_type: 'vercel_blob',
        connection: { blob_ref: 'https://blob.example.test/file.csv?token=secret' },
        auth: {
          type: 'signed_url_env',
          url_env: 'BLOB_URL',
          origin_env: 'BLOB_ORIGIN',
        },
      },
      {
        auth_env_vars: ['BLOB_ORIGIN', 'BLOB_URL'],
        spec_version: '1',
        type: 'integration',
        name: 'glob_private_upload',
        source_type: 'vercel_blob',
        connection: { blob_ref: 'attachments/*/uploaded.csv' },
        auth: {
          type: 'signed_url_env',
          url_env: 'BLOB_URL',
          origin_env: 'BLOB_ORIGIN',
        },
      },
    ];

    for (const spec of invalidSpecs) {
      const schema = 'source_type' in spec ? IntegrationSpecSchema : ResourceSpecSchema;
      expect(schema.safeParse(spec).success).toBe(false);
    }
  });

  it('keeps file resources out of the warehouse guard', () => {
    const parsed = ResourceSpecSchema.parse(baseResource);
    expect(isWarehouseResource(parsed)).toBe(false);
  });
});
