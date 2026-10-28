import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildAuthHeaders,
  parseSnowflakeConfig,
  SnowflakeWarehouseClient,
} from '../../src/runtime/snowflake-client.js';

function decodePayload(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

describe('parseSnowflakeConfig — rsa_key auth', () => {
  let tmpDir: string;
  let keyPath: string;

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    tmpDir = mkdtempSync(join(tmpdir(), 'sf-key-'));
    keyPath = join(tmpDir, 'rsa_key.p8');
    writeFileSync(keyPath, privateKey as string);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a JWT from the key file at parse time', () => {
    const config = parseSnowflakeConfig({
      accountIdentifier: 'acct123',
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      role: 'READER_ROLE',
      user: 'svc_user',
      auth: {
        type: 'rsa_key',
        private_key_path: keyPath,
      },
    });

    expect(config.auth.type).toBe('rsa_key');
    if (config.auth.type === 'rsa_key') {
      expect(config.auth.jwt).toBeTruthy();
      const payload = decodePayload(config.auth.jwt);
      expect(payload.sub).toBe('ACCT123.SVC_USER');
      expect(String(payload.iss)).toMatch(/^ACCT123\.SVC_USER\.SHA256:/);
    }
  });

  it('throws a clear error when the key file does not exist', () => {
    expect(() =>
      parseSnowflakeConfig({
        accountIdentifier: 'a',
        warehouse: 'w',
        database: 'd',
        schema: 's',
        role: 'r',
        user: 'u',
        auth: {
          type: 'rsa_key',
          private_key_path: join(tmpDir, 'missing.p8'),
        },
      })
    ).toThrow(/private key/i);
  });

  it('still accepts pat auth (backwards compatible)', () => {
    const config = parseSnowflakeConfig({
      accountIdentifier: 'a',
      warehouse: 'w',
      database: 'd',
      schema: 's',
      role: 'r',
      auth: { type: 'pat', token: 'xyz' },
    });
    expect(config.auth).toEqual({ type: 'pat', token: 'xyz' });
  });

  it('rejects unknown auth type with a helpful error', () => {
    expect(() =>
      parseSnowflakeConfig({
        accountIdentifier: 'a',
        warehouse: 'w',
        database: 'd',
        schema: 's',
        role: 'r',
        auth: { type: 'magic', token: 'x' },
      })
    ).toThrow(/unsupported auth type/i);
  });
});

describe('parseSnowflakeConfig — workload_identity auth', () => {
  const base = {
    accountIdentifier: 'acct123',
    warehouse: 'WH',
    database: 'DB',
    schema: 'PUBLIC',
    role: 'READER_ROLE',
  };

  it('accepts a resolved token and defaults provider to OIDC without a user', () => {
    const config = parseSnowflakeConfig({
      ...base,
      auth: { type: 'workload_identity', token: 'header.payload.sig' },
    });
    expect(config.auth).toEqual({
      type: 'workload_identity',
      provider: 'OIDC',
      token: 'header.payload.sig',
    });
  });

  it('keeps an explicit provider', () => {
    const config = parseSnowflakeConfig({
      ...base,
      auth: { type: 'workload_identity', provider: 'GCP', token: 'header.payload.sig' },
    });
    expect(config.auth).toEqual({
      type: 'workload_identity',
      provider: 'GCP',
      token: 'header.payload.sig',
    });
  });

  it('rejects an unsupported provider', () => {
    expect(() =>
      parseSnowflakeConfig({
        ...base,
        auth: { type: 'workload_identity', provider: 'AWS', token: 'header.payload.sig' },
      })
    ).toThrow(/provider/i);
  });

  it('rejects an empty token', () => {
    expect(() =>
      parseSnowflakeConfig({
        ...base,
        auth: { type: 'workload_identity', token: '' },
      })
    ).toThrow(/token/i);
  });

  it('rejects a token carrying header newline injection', () => {
    expect(() =>
      parseSnowflakeConfig({
        ...base,
        auth: { type: 'workload_identity', token: 'abc\r\nX-Injected: 1' },
      })
    ).toThrow(/token/i);
  });

  it('names workload_identity in the unsupported auth type error', () => {
    expect(() =>
      parseSnowflakeConfig({
        ...base,
        auth: { type: 'magic', token: 'x' },
      })
    ).toThrow(/workload_identity/);
  });
});

describe('buildAuthHeaders — workload_identity', () => {
  it('emits the WIF bearer prefix and WORKLOAD_IDENTITY_FEDERATION token type', () => {
    const headers = buildAuthHeaders({
      type: 'workload_identity',
      provider: 'OIDC',
      token: 'header.payload.sig',
    });
    expect(headers).toEqual({
      Authorization: 'Bearer WIF.OIDC.header.payload.sig',
      'X-Snowflake-Authorization-Token-Type': 'WORKLOAD_IDENTITY_FEDERATION',
    });
  });

  it('uses the configured provider in the bearer prefix', () => {
    const headers = buildAuthHeaders({
      type: 'workload_identity',
      provider: 'AZURE',
      token: 'header.payload.sig',
    });
    expect(headers.Authorization).toBe('Bearer WIF.AZURE.header.payload.sig');
  });
});

describe('buildAuthHeaders — rsa_key', () => {
  it('emits Authorization: Bearer + KEYPAIR_JWT token type', () => {
    const headers = buildAuthHeaders({ type: 'rsa_key', jwt: 'fake.jwt.value' });
    expect(headers).toEqual({
      Authorization: 'Bearer fake.jwt.value',
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    });
  });

  it('still handles pat', () => {
    expect(buildAuthHeaders({ type: 'pat', token: 'xyz' })).toEqual({
      Authorization: 'Bearer xyz',
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
    });
  });

  it('still handles oauth', () => {
    expect(buildAuthHeaders({ type: 'oauth', token: 'xyz' })).toEqual({
      Authorization: 'Bearer xyz',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    });
  });
});

// ---------------------------------------------------------------------------
// Regression tests for YAML→extractor integration path (added after hitting
// these against a real pipeline run in April 2026):
//   - resolveEnvVars produces snake_case keys; parseSnowflakeConfig must also
//     accept them instead of only camelCase.
//   - database/schema are optional defaults; resources override.
// ---------------------------------------------------------------------------
describe('parseSnowflakeConfig — snake_case + optional defaults', () => {
  it('accepts snake_case account_identifier (from resolveEnvVars output)', () => {
    const config = parseSnowflakeConfig({
      account_identifier: 'acct123',
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      role: 'READER_ROLE',
      auth: { type: 'pat', token: 'xyz' },
    });
    expect(config.accountIdentifier).toBe('acct123');
  });

  it('prefers camelCase when both cases present', () => {
    const config = parseSnowflakeConfig({
      accountIdentifier: 'camelWins',
      account_identifier: 'snakeLoses',
      warehouse: 'WH',
      auth: { type: 'pat', token: 'xyz' },
    });
    expect(config.accountIdentifier).toBe('camelWins');
  });

  it('accepts config without database/schema (integration-level defaults omitted)', () => {
    const config = parseSnowflakeConfig({
      accountIdentifier: 'acct',
      warehouse: 'WH',
      auth: { type: 'pat', token: 'xyz' },
    });
    expect(config.database).toBeUndefined();
    expect(config.schema).toBeUndefined();
    expect(config.warehouse).toBe('WH');
  });

  it('still rejects missing warehouse', () => {
    expect(() =>
      parseSnowflakeConfig({
        accountIdentifier: 'acct',
        auth: { type: 'pat', token: 'xyz' },
      })
    ).toThrow(/"warehouse" is required/);
  });

  it('still rejects missing accountIdentifier (neither case present)', () => {
    expect(() =>
      parseSnowflakeConfig({
        warehouse: 'WH',
        auth: { type: 'pat', token: 'xyz' },
      })
    ).toThrow(/"accountIdentifier" is required/);
  });

  it('validates snake_case database/schema when present', () => {
    expect(() =>
      parseSnowflakeConfig({
        account_identifier: 'acct',
        warehouse: 'WH',
        database: 'invalid-with-dashes',
        schema: 'PUBLIC',
        auth: { type: 'pat', token: 'xyz' },
      })
    ).toThrow(/database/i);
  });
});

describe('Snowflake query tags', () => {
  const base = {
    accountIdentifier: 'acct123',
    warehouse: 'WH',
    auth: { type: 'pat' as const, token: 'token' },
  };

  it.each(['', '   ', 'tag\nnext', 'tag\u0085next', 'x'.repeat(257)])(
    'rejects unsafe query tag %j',
    (queryTag) => {
      expect(() => parseSnowflakeConfig({ ...base, queryTag })).toThrow(/queryTag/);
    }
  );

  it('uses a trusted query tag in the SQL API statement body and retains the fallback', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statementHandle: 'abc',
            resultSetMetaData: { numRows: 0, rowType: [] },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statementHandle: 'def',
            resultSetMetaData: { numRows: 0, rowType: [] },
          }),
          { status: 200 }
        )
      );
    try {
      await new SnowflakeWarehouseClient({ ...base, queryTag: 'managed:run-42' })
        .execute('SELECT 1')
        .next();
      await new SnowflakeWarehouseClient(base).execute('SELECT 1').next();

      const taggedBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
        parameters: { QUERY_TAG: string };
      };
      const fallbackBody = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as {
        parameters: { QUERY_TAG: string };
      };
      expect(taggedBody.parameters.QUERY_TAG).toBe('managed:run-42');
      expect(fallbackBody.parameters.QUERY_TAG).toBe('dogsled-extractor');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
