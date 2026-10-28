import { describe, expect, it, vi } from 'vitest';

import {
  extractMergeAffectedRows,
  inferSnowflakeAuthenticator,
} from '../../../src/runtime/destinations/snowflake.js';
import type {
  SnowflakeConnectionLike,
  SnowflakeStatementResult,
  SnowflakeUploadResult,
} from '../../../src/runtime/destinations/snowflake.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

describe('extractMergeAffectedRows', () => {
  it('sums inserted and updated counts from a MERGE summary row', () => {
    expect(
      extractMergeAffectedRows([{ 'number of rows inserted': 97, 'number of rows updated': 3 }])
    ).toBe(100);
  });

  it('returns the insert count for an insert-only (fresh/empty table) merge', () => {
    // The driver's updates-only count would report 0 here — this is the bug.
    expect(
      extractMergeAffectedRows([{ 'number of rows inserted': 97, 'number of rows updated': 0 }])
    ).toBe(97);
  });

  it('coerces string counts', () => {
    expect(
      extractMergeAffectedRows([{ 'number of rows inserted': '12', 'number of rows updated': '0' }])
    ).toBe(12);
  });

  it('returns undefined when no summary row is present', () => {
    expect(extractMergeAffectedRows([])).toBeUndefined();
  });

  it('returns undefined when the row has no recognizable count columns', () => {
    expect(extractMergeAffectedRows([{ foo: 1, bar: 'baz' }])).toBeUndefined();
  });
});

describe('inferSnowflakeAuthenticator', () => {
  it('defaults to SNOWFLAKE_JWT when a private key is supplied and no authenticator is chosen', () => {
    expect(inferSnowflakeAuthenticator(undefined, '/path/to/key.p8')).toBe('SNOWFLAKE_JWT');
  });

  it('returns undefined when neither private key nor authenticator is supplied (falls through to password auth)', () => {
    expect(inferSnowflakeAuthenticator(undefined, undefined)).toBeUndefined();
  });

  it('passes through explicit OAUTH even when a private key is set', () => {
    expect(inferSnowflakeAuthenticator('OAUTH', '/path/to/key.p8')).toBe('OAUTH');
  });

  it('passes through explicit SNOWFLAKE_JWT without a private key (caller may inject privateKey via factory)', () => {
    expect(inferSnowflakeAuthenticator('SNOWFLAKE_JWT', undefined)).toBe('SNOWFLAKE_JWT');
  });
});

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

const ownedTableColumns = [
  { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER' },
  { COLUMN_NAME: 'TITLE', DATA_TYPE: 'TEXT' },
  { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
  { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
];

const ownedMarker = 'marker-A';

function createOwnedExistingConnection(tableCommentSequence: Array<string | null | undefined>) {
  return createMockConnection({
    connected: true,
    schemaExists: true,
    tableExists: true,
    tableComment: ownedMarker,
    tableCommentSequence,
    existingColumns: ownedTableColumns,
  });
}

const vectorColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'embedding', type: 'vector', dimension: 3 },
];

function createMockStatementResult(
  options: {
    rows?: Record<string, unknown>[];
    affectedRows?: number;
  } = {}
): SnowflakeStatementResult {
  return {
    getRows: vi.fn().mockReturnValue(options.rows ?? []),
    getAffectedRows: vi.fn().mockReturnValue(options.affectedRows ?? 0),
    getColumns: vi.fn().mockReturnValue([]),
  };
}

/** A connection that returns `mergeResult` for the MERGE statement and empty
 * results for every other execute (staging DDL, COPY INTO, REMOVE, DROP). */
function createMergeMockConnection(mergeResult: SnowflakeStatementResult): SnowflakeConnectionLike {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    execute: vi
      .fn()
      .mockImplementation(({ sqlText }: { sqlText: string }) =>
        Promise.resolve(sqlText.includes('MERGE INTO') ? mergeResult : createMockStatementResult())
      ),
    uploadFile: vi.fn().mockResolvedValue({ status: 'UPLOADED' } satisfies SnowflakeUploadResult),
    isClosed: vi.fn().mockReturnValue(false),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockConnection(
  options: {
    connected?: boolean;
    /** Return specific rows for the INFORMATION_SCHEMA query (2nd execute call in ensureTable) */
    existingColumns?: Array<{ COLUMN_NAME: string; DATA_TYPE: string }>;
    /** Match Snowflake's case-sensitive metadata values for unquoted identifiers. */
    requireUppercaseMetadataPredicates?: boolean;
    /** Return a row from TABLES even when COLUMNS is empty (existing shell table). */
    tableExists?: boolean;
    /** Return an existing administrator-provisioned schema for ownership tests. */
    schemaExists?: boolean;
    /** Simulate an INFORMATION_SCHEMA privilege failure during ownership checks. */
    schemaError?: Error;
    /** COMMENT exposed by INFORMATION_SCHEMA.TABLES for ownership tests. */
    tableComment?: string | null;
    /** Sequential COMMENT values for testing a table being replaced between phases. */
    tableCommentSequence?: Array<string | null | undefined>;
    clusteringKey?: string | null;
  } = {}
): SnowflakeConnectionLike {
  let tableExistsState =
    options.tableExists ??
    (options.existingColumns !== undefined && options.existingColumns.length > 0);
  let tableCommentState = options.tableComment;
  const tableCommentSequence = [...(options.tableCommentSequence ?? [])];
  const executeFn = vi.fn().mockImplementation(({ sqlText }: { sqlText: string }) => {
    if (sqlText.includes('.INFORMATION_SCHEMA.SCHEMATA')) {
      if (options.schemaError) {
        return Promise.reject(options.schemaError);
      }
      return Promise.resolve(
        createMockStatementResult({
          rows: options.schemaExists ? [{ SCHEMA_NAME: 'TEST_SCHEMA' }] : [],
        })
      );
    }
    if (sqlText.includes('.INFORMATION_SCHEMA.COLUMNS')) {
      if (
        options.requireUppercaseMetadataPredicates &&
        (!sqlText.includes("TABLE_SCHEMA = 'TEST_SCHEMA'") ||
          !sqlText.includes("TABLE_NAME = 'ISSUES'"))
      ) {
        return Promise.resolve(createMockStatementResult({ rows: [] }));
      }
      return Promise.resolve(createMockStatementResult({ rows: options.existingColumns ?? [] }));
    }
    if (sqlText.includes('.INFORMATION_SCHEMA.TABLES')) {
      if (sqlText.includes('SELECT TABLE_NAME')) {
        const exists = tableExistsState;
        if (sqlText.includes('COMMENT')) {
          const tableComment = exists
            ? tableCommentSequence.length > 0
              ? tableCommentSequence.shift()
              : tableCommentState
            : tableCommentState;
          return Promise.resolve(
            createMockStatementResult({
              rows: exists ? [{ TABLE_NAME: 'ISSUES', COMMENT: tableComment ?? null }] : [],
            })
          );
        }
        return Promise.resolve(
          createMockStatementResult({ rows: exists ? [{ TABLE_NAME: 'ISSUES' }] : [] })
        );
      }
      return Promise.resolve(
        createMockStatementResult({
          rows:
            options.clusteringKey === undefined ? [] : [{ CLUSTERING_KEY: options.clusteringKey }],
        })
      );
    }
    if (sqlText.startsWith('CREATE TABLE IF NOT EXISTS')) {
      tableExistsState = true;
      const commentMatch = sqlText.match(/COMMENT\s*=\s*'((?:''|[^'])*)'/i);
      tableCommentState = commentMatch?.[1]?.replaceAll("''", "'") ?? tableCommentState;
    }
    return Promise.resolve(createMockStatementResult());
  });

  return {
    connect: vi.fn().mockResolvedValue(undefined),
    execute: executeFn,
    uploadFile: vi.fn().mockResolvedValue({ status: 'UPLOADED' } satisfies SnowflakeUploadResult),
    isClosed: vi.fn().mockReturnValue(!(options.connected ?? false)),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockConnectionFactory(conn?: SnowflakeConnectionLike) {
  return vi.fn().mockReturnValue(conn ?? createMockConnection({ connected: true }));
}

function createWorkloadIdentityToken(exp: number): string {
  return createWorkloadIdentityTokenParts({ exp }).join('.');
}

function createWorkloadIdentityTokenParts(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'x' }
): [string, string, string] {
  const headerSegment = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = Buffer.from('signature!').toString('base64url');
  return [headerSegment, payloadSegment, signature];
}

function makeNoncanonicalBase64UrlSegment(segment: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lastIndex = alphabet.indexOf(segment.at(-1)!);
  return `${segment.slice(0, -1)}${alphabet[lastIndex + 1]}`;
}

function createLeakingError(message: string, token: string, code: unknown): Error {
  const error = new Error(message, { cause: new Error(token) });
  Object.assign(error, { code, customToken: token });
  return error;
}

function expectCleanSnowflakeError(
  error: unknown,
  original: Error,
  token: string,
  expectedCode: unknown = (original as Error & { code?: unknown }).code
): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBe(original);
  expect(error).toMatchObject({
    message: original.message,
    code: expectedCode,
  });
  expect(error).not.toHaveProperty('cause');
  expect(error).not.toHaveProperty('customToken');
  expect(Object.getOwnPropertyNames(error)).toEqual(
    expect.arrayContaining(['message', 'stack', 'code'])
  );
  expect(JSON.stringify(error)).not.toContain(token);
  expect(String(error)).not.toContain(token);
}

function createWorkloadIdentityDest(connection: SnowflakeConnectionLike) {
  const token = createWorkloadIdentityToken(1_700_003_600);
  return import('../../../src/runtime/destinations/snowflake.js').then(
    ({ SnowflakeDestination }) => ({
      dest: new SnowflakeDestination({
        account: 'test-account',
        username: 'test-user',
        workloadIdentityToken: token,
        warehouse: 'TEST_WH',
        database: 'TEST_DB',
        schema: 'TEST_SCHEMA',
        now: () => 1_700_000_000,
        connectionFactory: vi.fn().mockReturnValue(connection),
      }),
      token,
    })
  );
}

function createDest(conn?: SnowflakeConnectionLike) {
  const c = conn ?? createMockConnection({ connected: true });
  const factory = createMockConnectionFactory(c);
  // Dynamic import to get fresh module
  return import('../../../src/runtime/destinations/snowflake.js').then(
    ({ SnowflakeDestination }) => ({
      dest: new SnowflakeDestination({
        account: 'test-account',
        username: 'test-user',
        password: 'test-pass',
        warehouse: 'TEST_WH',
        database: 'TEST_DB',
        schema: 'TEST_SCHEMA',
        connectionFactory: factory,
      }),
      conn: c,
      factory,
    })
  );
}

describe('SnowflakeDestination', () => {
  // ── Initialization ──

  it.each([
    ['invalid JSON', Buffer.from('not-json').toString('base64url')],
    ['array', Buffer.from('[]').toString('base64url')],
    ['primitive', Buffer.from('"header"').toString('base64url')],
    ['missing alg', Buffer.from('{}').toString('base64url')],
    ['blank alg', Buffer.from('{"alg":"  "}').toString('base64url')],
    ['none alg', Buffer.from('{"alg":"none"}').toString('base64url')],
    ['uppercase none alg', Buffer.from('{"alg":"NONE"}').toString('base64url')],
  ] as const)(
    'rejects a %s JWT header before connecting without exposing the token',
    async (_name, header) => {
      const { SnowflakeDestination } =
        await import('../../../src/runtime/destinations/snowflake.js');
      const [, payload, signature] = createWorkloadIdentityToken(1_700_003_600).split('.');
      const token = `${header}.${payload}.${signature}`;
      const connectionFactory = vi.fn().mockReturnValue(createMockConnection({ connected: true }));
      const dest = new SnowflakeDestination({
        account: 'test-account',
        username: 'test-user',
        workloadIdentityToken: token,
        warehouse: 'TEST_WH',
        database: 'TEST_DB',
        schema: 'TEST_SCHEMA',
        now: () => 1_700_000_000,
        connectionFactory,
      });

      const error = await dest.initialize().catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/workload identity token|JWT header|JOSE alg/i);
      expect(String(error)).not.toContain(token);
      expect(connectionFactory).not.toHaveBeenCalled();
    }
  );

  it('rejects a malformed UTF-8 JWT header before connecting without exposing the token', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const malformedHeader = Buffer.from([
      0x7b, 0x22, 0x61, 0x6c, 0x67, 0x22, 0x3a, 0x22, 0x52, 0x53, 0xff, 0x32, 0x35, 0x36, 0x22,
      0x7d,
    ]).toString('base64url');
    const [, payload, signature] = createWorkloadIdentityToken(1_700_003_600).split('.');
    const token = `${malformedHeader}.${payload}.${signature}`;
    const connectionFactory = vi.fn().mockReturnValue(createMockConnection({ connected: true }));
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      workloadIdentityToken: token,
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      now: () => 1_700_000_000,
      connectionFactory,
    });

    const error = await dest.initialize().catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Snowflake workload identity token has an invalid JWT header.',
    });
    expect(String(error)).not.toContain(token);
    expect(connectionFactory).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical JWT payload before connecting', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const canonicalPayload = Buffer.from('{"exp":1700003600} ').toString('base64url');
    const noncanonicalPayload = `${canonicalPayload.slice(0, -1)}B`;
    const [header, , signature] = createWorkloadIdentityToken(1_700_003_600).split('.');
    const token = `${header}.${noncanonicalPayload}.${signature}`;
    const connectionFactory = vi.fn().mockReturnValue(createMockConnection({ connected: true }));
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      workloadIdentityToken: token,
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      now: () => 1_700_000_000,
      connectionFactory,
    });

    await expect(dest.initialize()).rejects.toThrow(/workload identity token/i);
    await expect(dest.initialize()).rejects.not.toThrow(token);
    expect(connectionFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['header', 0, 'Snowflake workload identity token has an invalid Base64URL header.'],
    ['signature', 2, 'Snowflake workload identity token has an invalid Base64URL signature.'],
  ] as const)(
    'rejects a noncanonical %s segment before connecting',
    async (_name, index, expectedError) => {
      const { SnowflakeDestination } =
        await import('../../../src/runtime/destinations/snowflake.js');
      const segments = createWorkloadIdentityToken(1_700_003_600).split('.');
      segments[index] = makeNoncanonicalBase64UrlSegment(segments[index]!);
      const token = segments.join('.');
      const connectionFactory = vi.fn().mockReturnValue(createMockConnection({ connected: true }));
      const dest = new SnowflakeDestination({
        account: 'test-account',
        username: 'test-user',
        workloadIdentityToken: token,
        warehouse: 'TEST_WH',
        database: 'TEST_DB',
        schema: 'TEST_SCHEMA',
        now: () => 1_700_000_000,
        connectionFactory,
      });

      await expect(dest.initialize()).rejects.toThrow(expectedError);
      await expect(dest.initialize()).rejects.not.toThrow(token);
      expect(connectionFactory).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['padded header', 0, '=', 'Snowflake workload identity token has an invalid Base64URL header.'],
    [
      'padded payload',
      1,
      '=',
      'Snowflake workload identity token has an invalid Base64URL payload.',
    ],
    [
      'padded signature',
      2,
      '=',
      'Snowflake workload identity token has an invalid Base64URL signature.',
    ],
    [
      'impossible-length header',
      0,
      'A',
      'Snowflake workload identity token has an invalid Base64URL header.',
    ],
    [
      'impossible-length payload',
      1,
      'A',
      'Snowflake workload identity token has an invalid Base64URL payload.',
    ],
    [
      'impossible-length signature',
      2,
      'A',
      'Snowflake workload identity token has an invalid Base64URL signature.',
    ],
  ] as const)(
    'rejects a %s segment before connecting',
    async (_name, index, replacement, expectedError) => {
      const { SnowflakeDestination } =
        await import('../../../src/runtime/destinations/snowflake.js');
      const segments = createWorkloadIdentityToken(1_700_003_600).split('.');
      segments[index] = replacement === '=' ? `${segments[index]}=` : replacement;
      const token = segments.join('.');
      const connectionFactory = vi.fn().mockReturnValue(createMockConnection({ connected: true }));
      const dest = new SnowflakeDestination({
        account: 'test-account',
        username: 'test-user',
        workloadIdentityToken: token,
        warehouse: 'TEST_WH',
        database: 'TEST_DB',
        schema: 'TEST_SCHEMA',
        now: () => 1_700_000_000,
        connectionFactory,
      });

      await expect(dest.initialize()).rejects.toThrow(expectedError);
      await expect(dest.initialize()).rejects.not.toThrow(token);
      expect(connectionFactory).not.toHaveBeenCalled();
    }
  );

  it('initializes with Snowflake workload identity driver options', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const connection = createMockConnection({ connected: true });
    const connectionFactory = vi.fn().mockReturnValue(connection);
    const token = createWorkloadIdentityToken(1_700_003_600);
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      workloadIdentityToken: token,
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      now: () => 1_700_000_000,
      connectionFactory,
    });

    await dest.initialize();

    expect(connectionFactory).toHaveBeenCalledWith({
      account: 'test-account',
      username: 'test-user',
      authenticator: 'WORKLOAD_IDENTITY',
      workloadIdentityProvider: 'OIDC',
      token,
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      password: undefined,
      privateKeyPath: undefined,
      privateKeyPassphrase: undefined,
      role: undefined,
    });
  });

  it('keeps a trusted query tag on the Snowflake connection configuration', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const connection = createMockConnection({ connected: true });
    const connectionFactory = vi.fn().mockReturnValue(connection);
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      password: 'test-password',
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      queryTag: 'custom:model-run:123',
      connectionFactory,
    });

    await dest.initialize();

    expect(connectionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ queryTag: 'custom:model-run:123' })
    );
  });

  const [canonicalHeader, canonicalPayload, canonicalSignature] = createWorkloadIdentityTokenParts({
    exp: 1_700_003_600,
  });

  it.each([
    [
      'two-part token',
      `${canonicalHeader}.${canonicalPayload}`,
      'Snowflake workload identity token must contain exactly three JWT segments.',
    ],
    [
      'invalid Base64URL payload',
      `${canonicalHeader}.%%%.${canonicalSignature}`,
      'Snowflake workload identity token has an invalid Base64URL payload.',
    ],
    [
      'empty header',
      `.${canonicalPayload}.${canonicalSignature}`,
      'Snowflake workload identity token has an invalid Base64URL header.',
    ],
    [
      'invalid Base64URL header',
      `%%%.${canonicalPayload}.${canonicalSignature}`,
      'Snowflake workload identity token has an invalid Base64URL header.',
    ],
    [
      'empty signature',
      `${canonicalHeader}.${canonicalPayload}.`,
      'Snowflake workload identity token has an invalid Base64URL signature.',
    ],
    [
      'invalid Base64URL signature',
      `${canonicalHeader}.${canonicalPayload}.%%%`,
      'Snowflake workload identity token has an invalid Base64URL signature.',
    ],
    [
      'missing exp',
      createWorkloadIdentityTokenParts({ sub: 'loader' }).join('.'),
      'Snowflake workload identity token must contain a safe-integer exp claim.',
    ],
    [
      'non-integer exp',
      createWorkloadIdentityTokenParts({ exp: 1.5 }).join('.'),
      'Snowflake workload identity token must contain a safe-integer exp claim.',
    ],
    [
      'expired exp',
      createWorkloadIdentityToken(1_699_999_999),
      'Snowflake workload identity token is expired.',
    ],
    [
      'CR/LF',
      `${canonicalHeader}.${canonicalPayload}.${canonicalSignature}\n`,
      'Snowflake workload identity token must not contain CR or LF characters.',
    ],
  ] as const)('rejects a %s WIF token before connecting', async (_name, token, expectedError) => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const connectionFactory = vi.fn().mockReturnValue(createMockConnection());
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      workloadIdentityToken: token,
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      now: () => 1_700_000_000,
      connectionFactory,
    });

    await expect(dest.initialize()).rejects.toThrow(expectedError);
    expect(connectionFactory).not.toHaveBeenCalled();
    await expect(dest.initialize()).rejects.not.toThrow(token);
  });

  it.each([
    ['PAT', { password: 'pat-token' }],
    ['OAuth access token', { accessToken: 'oauth-token' }],
    ['OAuth token command', { tokenProvider: vi.fn() }],
    ['RSA private key', { privateKeyPath: '/tmp/key.p8' }],
    ['RSA passphrase', { privateKeyPassphrase: 'key-passphrase' }],
    ['OAuth authenticator', { authenticator: 'OAUTH' as const }],
    ['RSA authenticator', { authenticator: 'SNOWFLAKE_JWT' as const }],
  ])('rejects WIF combined with %s without exposing the token', async (_name, conflict) => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const token = createWorkloadIdentityToken(1_700_003_600);
    const connectionFactory = vi.fn();
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      workloadIdentityToken: token,
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      connectionFactory,
      ...conflict,
    });

    await expect(dest.initialize()).rejects.toThrow(/workload identity token/i);
    expect(connectionFactory).not.toHaveBeenCalled();
    await expect(dest.initialize()).rejects.not.toThrow(token);
  });

  it('fails the attempt after a WIF token expires instead of reconnecting', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    let now = 1_700_000_000;
    const connection = createMockConnection({ connected: true });
    const connectionFactory = vi.fn().mockReturnValue(connection);
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      workloadIdentityToken: createWorkloadIdentityToken(1_700_000_100),
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      now: () => now,
      connectionFactory,
    });

    await dest.initialize();
    now = 1_700_000_100;

    await expect(dest.ensureTable('PUBLIC', 'TABLE', issueColumns)).rejects.toThrow(
      /expired|reconnect/i
    );
    expect(connectionFactory).toHaveBeenCalledTimes(1);
  });

  it('fails the attempt when a WIF connection is closed instead of reconnecting', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const connection = createMockConnection({ connected: true });
    const connectionFactory = vi.fn().mockReturnValue(connection);
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      workloadIdentityToken: createWorkloadIdentityToken(1_700_003_600),
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      now: () => 1_700_000_000,
      connectionFactory,
    });

    await dest.initialize();
    vi.mocked(connection.isClosed).mockReturnValue(true);

    await expect(dest.ensureTable('PUBLIC', 'TABLE', issueColumns)).rejects.toThrow(
      /closed|reconnect/i
    );
    expect(connectionFactory).toHaveBeenCalledTimes(1);
  });

  it('sanitizes connection errors into clean error objects', async () => {
    const connection = createMockConnection({ connected: true });
    const { dest, token } = await createWorkloadIdentityDest(connection);
    const original = createLeakingError('connection failed', token, `E_CONNECT_${token}`);
    vi.mocked(connection.connect).mockRejectedValue(original);

    const error = await dest.initialize().catch((caught) => caught);

    expectCleanSnowflakeError(error, original, token, 'E_CONNECT_[REDACTED]');
  });

  it('sanitizes execution errors into clean error objects', async () => {
    const connection = createMockConnection({ connected: true });
    const { dest, token } = await createWorkloadIdentityDest(connection);
    const original = createLeakingError('execution failed', token, `E_EXECUTE_${token}`);
    await dest.initialize();
    vi.mocked(connection.execute).mockRejectedValueOnce(original);

    const error = await dest.ensureTable('PUBLIC', 'TABLE', issueColumns).catch((caught) => caught);

    expectCleanSnowflakeError(error, original, token, 'E_EXECUTE_[REDACTED]');
  });

  it('sanitizes upload errors into clean error objects', async () => {
    const connection = createMockConnection({ connected: true });
    const { dest, token } = await createWorkloadIdentityDest(connection);
    const original = createLeakingError('upload failed', token, `E_UPLOAD_${token}`);
    await dest.initialize();
    vi.mocked(connection.uploadFile).mockRejectedValueOnce(original);

    const error = await dest
      .loadAndFinalize('PUBLIC', 'TABLE', '/tmp/data.jsonl', issueColumns, 'append', [])
      .catch((caught) => caught);

    expectCleanSnowflakeError(error, original, token, 'E_UPLOAD_[REDACTED]');
  });

  it('sanitizes destroy errors into clean error objects', async () => {
    const connection = createMockConnection({ connected: true });
    const { dest, token } = await createWorkloadIdentityDest(connection);
    const original = createLeakingError('destroy failed', token, `E_DESTROY_${token}`);
    await dest.initialize();
    vi.mocked(connection.destroy).mockRejectedValueOnce(original);

    const error = await dest.close().catch((caught) => caught);

    expectCleanSnowflakeError(error, original, token, 'E_DESTROY_[REDACTED]');
  });

  it('preserves numeric error codes while sanitizing connection errors', async () => {
    const connection = createMockConnection({ connected: true });
    const { dest, token } = await createWorkloadIdentityDest(connection);
    const original = createLeakingError('connection failed', token, 503);
    vi.mocked(connection.connect).mockRejectedValue(original);

    const error = await dest.initialize().catch((caught) => caught);

    expectCleanSnowflakeError(error, original, token);
    expect((error as Error & { code?: unknown }).code).toBe(503);
  });

  it('preserves ordinary safe string error codes while sanitizing connection errors', async () => {
    const connection = createMockConnection({ connected: true });
    const { dest, token } = await createWorkloadIdentityDest(connection);
    const original = createLeakingError('connection failed', token, 'E_CONNECT');
    vi.mocked(connection.connect).mockRejectedValue(original);

    const error = await dest.initialize().catch((caught) => caught);

    expectCleanSnowflakeError(error, original, token);
    expect((error as Error & { code?: unknown }).code).toBe('E_CONNECT');
  });

  it('initialize() emits PAT credentials through Snowflake password auth', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const conn = createMockConnection();
    const factory = createMockConnectionFactory(conn);
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      password: 'pat-token',
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      role: 'TEST_ROLE',
      connectionFactory: factory,
    });

    await dest.initialize();

    expect(factory).toHaveBeenCalledWith({
      account: 'test-account',
      username: 'test-user',
      password: 'pat-token',
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      role: 'TEST_ROLE',
    });
    expect(conn.connect).toHaveBeenCalled();
  });

  it('initialize() throws when connection fails', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const conn = createMockConnection();
    vi.mocked(conn.connect).mockRejectedValue(new Error('Connection refused'));
    const factory = createMockConnectionFactory(conn);
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      password: 'test-pass',
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      connectionFactory: factory,
    });

    await expect(dest.initialize()).rejects.toThrow('Connection refused');
  });

  it('initialize() accepts optional private key path', async () => {
    const { SnowflakeDestination } = await import('../../../src/runtime/destinations/snowflake.js');
    const conn = createMockConnection();
    const factory = createMockConnectionFactory(conn);
    const dest = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      privateKeyPath: '/path/to/key.pem',
      privateKeyPassphrase: 'secret',
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      connectionFactory: factory,
    });

    await dest.initialize();

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKeyPath: '/path/to/key.pem',
        privateKeyPassphrase: 'secret',
      })
    );
  });

  // ── ensureTable — table creation ──

  it('ensureTable() creates table with DDL including system columns', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createTableCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createTableCall).toBeDefined();
    const sql = createTableCall![0].sqlText;
    expect(sql).toContain('"ID" NUMBER(38,0)');
    expect(sql).toContain('"TITLE" VARCHAR');
    expect(sql).toContain('"_TIME_EXTRACTED" TIMESTAMP_TZ');
    expect(sql).toContain('"_DOGSLED_LOADED_AT" TIMESTAMP_TZ');
  });

  it('ensureTable() rejects empty columns before emitting SQL', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await expect(dest.ensureTable('test_schema', 'empty_stream', [])).rejects.toMatchObject({
      message:
        'stream "empty_stream" declares no columns; refusing to create or load a destination table',
      exitCode: 2,
    });
    expect(conn.execute).not.toHaveBeenCalled();
  });

  it('rejects column names that collide after Snowflake case normalization', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await expect(
      dest.ensureTable('test_schema', 'issues', [
        { name: 'domain', type: 'string' },
        { name: 'DOMAIN', type: 'string' },
      ])
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('duplicate columns'),
    });
    expect(conn.execute).not.toHaveBeenCalled();
  });

  it('ensureTable() creates VECTOR(FLOAT, N) columns for vector schemas', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('test_schema', 'embeddings', vectorColumns);

    const createTableCall = vi
      .mocked(conn.execute)
      .mock.calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createTableCall![0].sqlText).toContain('"EMBEDDING" VECTOR(FLOAT, 3)');
  });

  it('loads into an existing schema without requesting database CREATE SCHEMA privileges', async () => {
    const conn = createMockConnection({ connected: true, schemaExists: true });
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns);
    const statements = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(statements.some((sql) => sql.includes('.INFORMATION_SCHEMA.SCHEMATA'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('CREATE SCHEMA'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('CREATE TABLE'))).toBe(true);
  });

  it('does not try schema or table creation when schema metadata access fails', async () => {
    const error = Object.assign(new Error('schema metadata access denied'), {
      code: '002003',
      sqlState: '42501',
    });
    const conn = createMockConnection({ connected: true, schemaError: error });
    const { dest } = await createDest(conn);
    await dest.initialize();
    await expect(dest.ensureTable('test_schema', 'issues', issueColumns)).rejects.toThrow(
      /schema metadata access denied/
    );
    expect(
      vi.mocked(conn.execute).mock.calls.some(([call]) => call.sqlText.startsWith('CREATE '))
    ).toBe(false);
  });

  it('ensureTable() creates a missing schema after checking metadata', async () => {
    const conn = createMockConnection({ connected: true, schemaExists: false });
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns);

    const statements = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(statements[0]).toContain('.INFORMATION_SCHEMA.SCHEMATA');
    expect(statements[1]).toContain('CREATE SCHEMA IF NOT EXISTS "TEST_SCHEMA"');
  });

  it('ensureTable() uses CREATE TABLE IF NOT EXISTS (not CREATE OR REPLACE)', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createCall![0].sqlText).toContain('CREATE TABLE IF NOT EXISTS');
    expect(createCall![0].sqlText).not.toContain('CREATE OR REPLACE');
  });

  it('owner-guarded tables require an existing schema and atomically claim new tables with a COMMENT marker', async () => {
    const conn = createMockConnection({ connected: true, schemaExists: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: 'temp-dataset-123',
    });

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(sql.some((statement) => statement.includes('CREATE SCHEMA'))).toBe(false);
    const createTable = sql.find((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS'));
    expect(createTable).toContain("COMMENT = 'temp-dataset-123'");
    expect(sql.filter((statement) => statement.includes('COMMENT FROM')).length).toBeGreaterThan(0);
  });

  it('preserves the exact case of an opaque owner-guarded table through create and load', async () => {
    const tableName = 'DS_CSV_aB12cD';
    const marker = 'temp-dataset-mixed-case';
    const conn = createMockConnection({
      connected: true,
      schemaExists: true,
      tableExists: false,
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable('test_schema', tableName, issueColumns, {
      tableOwnershipMarker: marker,
    });

    const createSql = vi
      .mocked(conn.execute)
      .mock.calls.map(([call]) => call.sqlText)
      .find((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS'));
    expect(createSql).toContain('"TEST_SCHEMA"."DS_CSV_aB12cD"');
    expect(createSql).not.toContain('"DS_CSV_AB12CD"');

    await dest.loadAndFinalize(
      'test_schema',
      tableName,
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    expect(conn.uploadFile).toHaveBeenCalledWith({
      srcPath: '/tmp/data.jsonl',
      destLoc: '@%"DS_CSV_aB12cD"/data.jsonl',
    });
    const copySql = vi
      .mocked(conn.execute)
      .mock.calls.map(([call]) => call.sqlText)
      .find((statement) => statement.startsWith('COPY INTO'));
    expect(copySql).toContain('COPY INTO "TEST_SCHEMA"."DS_CSV_aB12cD"');
  });

  it('revalidates ownership before loading after schema handling', async () => {
    const marker = 'temp-dataset-123';
    const conn = createMockConnection({
      connected: true,
      schemaExists: true,
      tableExists: false,
      tableCommentSequence: [marker, 'another-dataset'],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: marker,
    });

    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'append', [])
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not owned'),
    });
    expect(conn.uploadFile).not.toHaveBeenCalled();
    expect(
      vi.mocked(conn.execute).mock.calls.some(([call]) => call.sqlText.startsWith('COPY INTO'))
    ).toBe(false);
  });

  it('uses the exact mixed-case table identifier when rebuilding an owned table', async () => {
    const tableName = 'DS_CSV_aB12cD';
    const marker = 'temp-dataset-mixed-case';
    const conn = createMockConnection({
      connected: true,
      schemaExists: true,
      tableExists: true,
      tableComment: marker,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'STALE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable('test_schema', tableName, issueColumns, {
      tableOwnershipMarker: marker,
      loadStrategy: 'full_refresh',
    });

    const replacement = vi
      .mocked(conn.execute)
      .mock.calls.map(([call]) => call.sqlText)
      .find((statement) => statement.startsWith('CREATE OR REPLACE TABLE'));
    expect(replacement).toContain('CREATE OR REPLACE TABLE "TEST_SCHEMA"."DS_CSV_aB12cD"');
    expect(replacement).toContain("COMMENT = 'temp-dataset-mixed-case'");
  });

  it('owner-guarded tables fail clearly when the administrator-provisioned schema is missing', async () => {
    const conn = createMockConnection({ connected: true, schemaExists: false });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(
      dest.ensureTable('test_schema', 'issues', issueColumns, {
        tableOwnershipMarker: 'temp-dataset-123',
      })
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('does not exist'),
    });

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(sql.some((statement) => statement.includes('CREATE SCHEMA'))).toBe(false);
    expect(sql.some((statement) => statement.startsWith('CREATE TABLE'))).toBe(false);
  });

  it('does not fall back to schema creation when metadata access is denied', async () => {
    const conn = createMockConnection({
      connected: true,
      schemaError: Object.assign(new Error('insufficient privileges to read SCHEMATA'), {
        code: '42501',
      }),
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(
      dest.ensureTable('test_schema', 'issues', issueColumns, {
        tableOwnershipMarker: 'temp-dataset-123',
      })
    ).rejects.toThrow('insufficient privileges');

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(sql.some((statement) => statement.includes('CREATE SCHEMA'))).toBe(false);
    expect(sql.some((statement) => statement.startsWith('CREATE TABLE'))).toBe(false);
  });

  it('refuses to mutate an unrelated existing table when its COMMENT marker does not match', async () => {
    const conn = createMockConnection({
      connected: true,
      schemaExists: true,
      tableExists: true,
      tableComment: 'another-dataset',
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(
      dest.ensureTable('test_schema', 'issues', issueColumns, {
        tableOwnershipMarker: 'temp-dataset-123',
        loadStrategy: 'full_refresh',
      })
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not owned'),
    });

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(sql.some((statement) => statement.startsWith('ALTER TABLE'))).toBe(false);
    expect(sql.some((statement) => statement.startsWith('CREATE OR REPLACE TABLE'))).toBe(false);
  });

  it('preserves the ownership marker when rebuilding a drifted owned table', async () => {
    const conn = createMockConnection({
      connected: true,
      schemaExists: true,
      tableExists: true,
      tableComment: 'temp-dataset-123',
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'STALE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: 'temp-dataset-123',
      loadStrategy: 'full_refresh',
    });

    const replacement = vi
      .mocked(conn.execute)
      .mock.calls.map(([call]) => call.sqlText)
      .find((statement) => statement.startsWith('CREATE OR REPLACE TABLE'));
    expect(replacement).toContain("COMMENT = 'temp-dataset-123'");
  });

  it('rechecks ownership inside an append COPY retry before retrying the mutation', async () => {
    const conn = createOwnedExistingConnection([
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      'marker-B',
    ]);
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: ownedMarker,
    });

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let copyAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (sqlText.includes('COPY INTO') && copyAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'append', [])
    ).rejects.toThrow(/not owned/);
    expect(copyAttempts).toBe(1);
  });

  it('rechecks ownership inside a cached ALTER retry before retrying the mutation', async () => {
    const conn = createOwnedExistingConnection([ownedMarker, ownedMarker, ownedMarker, 'marker-B']);
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: ownedMarker,
    });

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let alterAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (sqlText.startsWith('ALTER TABLE') && alterAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.ensureTable(
        'test_schema',
        'issues',
        [...issueColumns, { name: 'new_col', type: 'string' }],
        { tableOwnershipMarker: ownedMarker }
      )
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not owned'),
    });
    expect(alterAttempts).toBe(1);
  });

  it('rechecks ownership inside CREATE OR REPLACE retries before rebuilding', async () => {
    const conn = createMockConnection({
      connected: true,
      schemaExists: true,
      tableExists: true,
      tableComment: ownedMarker,
      tableCommentSequence: [ownedMarker, ownedMarker, ownedMarker, 'marker-B'],
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'STALE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let replacementAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (sqlText.startsWith('CREATE OR REPLACE TABLE') && replacementAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.ensureTable('test_schema', 'issues', issueColumns, {
        tableOwnershipMarker: ownedMarker,
        loadStrategy: 'full_refresh',
      })
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not owned'),
    });
    expect(replacementAttempts).toBe(1);
  });

  it.each([
    ['empty', ''],
    ['control character', 'staged\n123'],
    ['surrounding whitespace', ' staged-123'],
    ['oversized', 'x'.repeat(257)],
  ])('rejects an invalid %s ownership marker before SQL', async (_name, marker) => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await expect(
      dest.ensureTable('test_schema', 'issues', issueColumns, {
        tableOwnershipMarker: marker,
      })
    ).rejects.toThrow(/ownership marker/i);
    expect(conn.execute).not.toHaveBeenCalled();
  });

  it('fails without poisoning the cache when TABLES finds a column-less existing table', async () => {
    const conn = createMockConnection({
      connected: true,
      requireUppercaseMetadataPredicates: true,
      existingColumns: [],
      tableExists: true,
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(dest.ensureTable('test_schema', 'issues', issueColumns)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('INFORMATION_SCHEMA.COLUMNS returned no visible columns'),
    });

    // A failed metadata lookup must not seed the expected schema in the cache.
    // The next ensure must repeat both metadata queries rather than taking a
    // cache fast path and hiding the same visibility problem.
    await expect(dest.ensureTable('test_schema', 'issues', issueColumns)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('INFORMATION_SCHEMA.COLUMNS returned no visible columns'),
    });

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(
      sql.filter((statement) =>
        statement.includes('SELECT TABLE_NAME FROM "TEST_DB".INFORMATION_SCHEMA.TABLES')
      )
    ).toHaveLength(2);
    expect(
      sql.filter((statement) => statement.includes('.INFORMATION_SCHEMA.COLUMNS'))
    ).toHaveLength(2);
    expect(sql.some((statement) => statement.startsWith('CREATE TABLE'))).toBe(false);
  });

  // ── ensureTable — schema evolution ──

  it('ensureTable() adds new columns via ALTER TABLE when table exists', async () => {
    const conn = createMockConnection({
      connected: true,
      requireUppercaseMetadataPredicates: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    // Call ensureTable with a new 'title' column not in existing columns
    await dest.ensureTable('test_schema', 'issues', issueColumns);

    const calls = vi.mocked(conn.execute).mock.calls;
    const alterCall = calls.find((c) => c[0].sqlText.includes('ALTER TABLE'));
    expect(alterCall).toBeDefined();
    expect(alterCall![0].sqlText).toContain('ADD COLUMN "TITLE" VARCHAR');
  });

  it('replaces a system-column-only table before a Snowflake full-refresh load', async () => {
    const conn = createMockConnection({
      connected: true,
      requireUppercaseMetadataPredicates: true,
      existingColumns: [
        { COLUMN_NAME: '_time_extracted', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_dogsled_loaded_at', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      loadStrategy: 'full_refresh',
    });
    await expect(
      dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/issues.jsonl',
        issueColumns,
        'full_refresh',
        []
      )
    ).resolves.toEqual({ rowsAffected: 0 });

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    const replaceIndex = sql.findIndex((statement) =>
      statement.startsWith('CREATE OR REPLACE TABLE')
    );
    const copyIndex = sql.findIndex((statement) => statement.startsWith('COPY INTO'));
    expect(replaceIndex).toBeGreaterThan(-1);
    expect(sql[replaceIndex]).toContain('"ID" NUMBER(38,0)');
    expect(sql[replaceIndex]).toContain('"TITLE" VARCHAR');
    expect(sql[replaceIndex]).toContain('"_TIME_EXTRACTED" TIMESTAMP_TZ');
    expect(sql[replaceIndex]).toContain('"_DOGSLED_LOADED_AT" TIMESTAMP_TZ');
    expect(sql[replaceIndex]).toContain('COPY GRANTS');
    expect(copyIndex).toBeGreaterThan(replaceIndex);
  });

  it('replaces a drifted table during a Snowflake full_refresh while preserving grants', async () => {
    const conn = createMockConnection({
      connected: true,
      requireUppercaseMetadataPredicates: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'STALE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
      clusteringKey: 'LINEAR("STALE")',
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      loadStrategy: 'full_refresh',
      keyProperties: ['id'],
    });

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    const replacement = sql.find((statement) => statement.startsWith('CREATE OR REPLACE TABLE'));
    expect(replacement).toBeDefined();
    expect(replacement).toContain('"ID" NUMBER(38,0)');
    expect(replacement).toContain('"TITLE" VARCHAR');
    expect(replacement).toContain('"_TIME_EXTRACTED" TIMESTAMP_TZ');
    expect(replacement).toContain('"_DOGSLED_LOADED_AT" TIMESTAMP_TZ');
    expect(replacement).toContain('COPY GRANTS');
    expect(sql.some((statement) => statement.includes('DROP COLUMN'))).toBe(false);
    expect(sql.some((statement) => statement.includes('CLUSTER BY ("ID")'))).toBe(true);
  });

  it('does not replace a Snowflake table during full_refresh when there is no schema drift', async () => {
    const conn = createMockConnection({
      connected: true,
      requireUppercaseMetadataPredicates: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER' },
        { COLUMN_NAME: 'TITLE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
      clusteringKey: 'LINEAR("ID")',
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      loadStrategy: 'full_refresh',
      keyProperties: ['id'],
    });

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(sql.some((statement) => statement.startsWith('CREATE OR REPLACE TABLE'))).toBe(false);
    expect(sql.some((statement) => statement.includes('ALTER TABLE'))).toBe(false);
  });

  it('keeps strict full_refresh as a drift detector', async () => {
    const conn = createMockConnection({
      connected: true,
      requireUppercaseMetadataPredicates: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'STALE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(
      dest.ensureTable('test_schema', 'issues', issueColumns, {
        loadStrategy: 'full_refresh',
        schemaBehavior: 'strict',
      })
    ).rejects.toThrow('Schema contract violation (strict)');

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(sql.some((statement) => statement.startsWith('CREATE OR REPLACE TABLE'))).toBe(false);
    expect(sql.some((statement) => statement.startsWith('ALTER TABLE'))).toBe(false);
  });

  it('keeps freeze full_refresh from changing a drifted schema', async () => {
    const conn = createMockConnection({
      connected: true,
      requireUppercaseMetadataPredicates: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'STALE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      loadStrategy: 'full_refresh',
      schemaBehavior: 'freeze',
    });

    const sql = vi.mocked(conn.execute).mock.calls.map(([call]) => call.sqlText);
    expect(sql.some((statement) => statement.startsWith('CREATE OR REPLACE TABLE'))).toBe(false);
    expect(sql.some((statement) => statement.startsWith('ALTER TABLE'))).toBe(false);
  });

  it('ensureTable() reconciles strict drift with quoted add, widen, and drop DDL', async () => {
    const conn = createMockConnection({
      connected: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER' },
        { COLUMN_NAME: 'AMOUNT', DATA_TYPE: 'NUMBER' },
        { COLUMN_NAME: 'STALE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable(
      'test_schema',
      'issues',
      [
        { name: 'id', type: 'integer' },
        { name: 'amount', type: 'number' },
        { name: 'new_col', type: 'string' },
      ],
      { schemaBehavior: 'strict', reconcileSchema: true }
    );

    const alterSql = vi
      .mocked(conn.execute)
      .mock.calls.map(([call]) => call.sqlText)
      .filter((sql) => sql.startsWith('ALTER TABLE'));
    expect(alterSql).toEqual([
      'ALTER TABLE "TEST_SCHEMA"."ISSUES" ADD COLUMN "NEW_COL" VARCHAR',
      'ALTER TABLE "TEST_SCHEMA"."ISSUES" ALTER COLUMN "AMOUNT" SET DATA TYPE FLOAT',
      'ALTER TABLE "TEST_SCHEMA"."ISSUES" DROP COLUMN "STALE"',
    ]);
    expect(alterSql.some((sql) => /DROP TABLE|RENAME TABLE/i.test(sql))).toBe(false);

    // The updated cache makes a repeated repair a no-op for schema DDL.
    const callCount = vi.mocked(conn.execute).mock.calls.length;
    await dest.ensureTable(
      'test_schema',
      'issues',
      [
        { name: 'id', type: 'integer' },
        { name: 'amount', type: 'number' },
        { name: 'new_col', type: 'string' },
      ],
      { schemaBehavior: 'strict', reconcileSchema: true }
    );
    expect(vi.mocked(conn.execute).mock.calls.length).toBe(callCount);
  });

  it('ensureTable() keeps non-widenable type conflicts guarded during reconciliation', async () => {
    const conn = createMockConnection({
      connected: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(
      dest.ensureTable('test_schema', 'issues', [{ name: 'id', type: 'integer' }], {
        schemaBehavior: 'strict',
        reconcileSchema: true,
      })
    ).rejects.toThrow('Schema change conflict');
    expect(
      vi.mocked(conn.execute).mock.calls.some(([call]) => call.sqlText.startsWith('ALTER TABLE'))
    ).toBe(false);
  });

  it('ensureTable() detects type conflicts and throws', async () => {
    const conn = createMockConnection({
      connected: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'TEXT' }, // was NUMBER, now TEXT = conflict
        { COLUMN_NAME: 'TITLE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(dest.ensureTable('test_schema', 'issues', issueColumns)).rejects.toThrow(
      'Schema change conflict'
    );
  });

  it('ensureTable() skips API calls when column cache is populated', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    // First call populates cache
    await dest.ensureTable('test_schema', 'issues', issueColumns);
    const callCountAfterFirst = vi.mocked(conn.execute).mock.calls.length;

    // Second call with same columns should skip INFORMATION_SCHEMA query
    await dest.ensureTable('test_schema', 'issues', issueColumns);
    const callCountAfterSecond = vi.mocked(conn.execute).mock.calls.length;

    expect(callCountAfterSecond).toBe(callCountAfterFirst);
  });

  it('ensureTable() applies CLUSTER BY on existing tables when clustering is requested', async () => {
    const conn = createMockConnection({
      connected: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER' },
        { COLUMN_NAME: 'TITLE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'UPDATED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable(
      'test_schema',
      'issues',
      [...issueColumns, { name: 'updated_at', type: 'timestamp' }],
      {
        keyProperties: ['id'],
        cursorField: 'updated_at',
      }
    );

    const clusterCall = vi
      .mocked(conn.execute)
      .mock.calls.find((c) => c[0].sqlText.includes('CLUSTER BY'));
    expect(clusterCall?.[0].sqlText).toContain('CLUSTER BY ("UPDATED_AT", "ID")');
  });

  it('ensureTable() skips CLUSTER BY when Snowflake metadata already matches', async () => {
    const conn = createMockConnection({
      connected: true,
      existingColumns: [
        { COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER' },
        { COLUMN_NAME: 'TITLE', DATA_TYPE: 'TEXT' },
        { COLUMN_NAME: 'UPDATED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_TIME_EXTRACTED', DATA_TYPE: 'TIMESTAMP_TZ' },
        { COLUMN_NAME: '_DOGSLED_LOADED_AT', DATA_TYPE: 'TIMESTAMP_TZ' },
      ],
      clusteringKey: 'LINEAR("UPDATED_AT", "ID")',
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.ensureTable(
      'test_schema',
      'issues',
      [...issueColumns, { name: 'updated_at', type: 'timestamp' }],
      {
        keyProperties: ['id'],
        cursorField: 'updated_at',
      }
    );

    const clusterCall = vi
      .mocked(conn.execute)
      .mock.calls.find((c) => c[0].sqlText.includes('CLUSTER BY'));
    expect(clusterCall).toBeUndefined();
  });

  // ── loadAndFinalize — append ──

  it('loadAndFinalize("append") uploads file to stage and COPY INTO', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    expect(conn.uploadFile).toHaveBeenCalledWith({
      srcPath: '/tmp/data.jsonl',
      destLoc: '@%issues/data.jsonl',
    });

    const calls = vi.mocked(conn.execute).mock.calls;
    const copyCall = calls.find((c) => c[0].sqlText.includes('COPY INTO'));
    expect(copyCall).toBeDefined();
    expect(copyCall![0].sqlText).toContain('COPY INTO');
    expect(copyCall![0].sqlText).toContain('FILE_FORMAT = (TYPE = JSON)');
    expect(copyCall![0].sqlText).toContain('PURGE = TRUE');
    expect(result.rowsAffected).toBe(0);
  });

  it('loadAndFinalize() rejects empty columns before emitting SQL or uploading', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_schema', 'empty_stream', '/tmp/data.jsonl', [], 'append', [])
    ).rejects.toMatchObject({
      message:
        'stream "empty_stream" declares no columns; refusing to create or load a destination table',
      exitCode: 2,
    });
    expect(conn.execute).not.toHaveBeenCalled();
    expect(conn.uploadFile).not.toHaveBeenCalled();
  });

  it('loadAndFinalize("append") uses PARQUET COPY semantics for parquet batches', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.parquet',
      issueColumns,
      'append',
      [],
      { format: 'parquet' }
    );

    const copyCall = vi
      .mocked(conn.execute)
      .mock.calls.find((call) => call[0].sqlText.includes('COPY INTO'));
    expect(copyCall).toBeDefined();
    expect(copyCall![0].sqlText).toContain('FILE_FORMAT = (TYPE = PARQUET)');
    expect(copyCall![0].sqlText).toContain('MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE');

    const updateCall = vi
      .mocked(conn.execute)
      .mock.calls.find((call) =>
        call[0].sqlText.includes('SET "_DOGSLED_LOADED_AT" = CURRENT_TIMESTAMP()')
      );
    expect(updateCall).toBeDefined();
  });

  it('loadAndFinalize("append") reads _time_extracted from JSON data (not CURRENT_TIMESTAMP)', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    const calls = vi.mocked(conn.execute).mock.calls;
    const copyCall = calls.find((c) => c[0].sqlText.includes('COPY INTO'));
    const sql = copyCall![0].sqlText;
    // Should reference $1:"_time_extracted"::TIMESTAMP_TZ from the JSON data
    expect(sql).toContain('$1:"_time_extracted"::TIMESTAMP_TZ');
    // Should NOT use CURRENT_TIMESTAMP() for _time_extracted
    expect(sql).not.toMatch(/CURRENT_TIMESTAMP\(\)\s+AS\s+"_time_extracted"/i);
  });

  it('loadAndFinalize("append") uses $1:"field"::TYPE for JSON column access', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    const calls = vi.mocked(conn.execute).mock.calls;
    const copyCall = calls.find((c) => c[0].sqlText.includes('COPY INTO'));
    const sql = copyCall![0].sqlText;
    expect(sql).toContain('$1:"id"::NUMBER(38,0)');
    expect(sql).toContain('$1:"title"::VARCHAR');
  });

  it('loadAndFinalize("append") casts JSON arrays into Snowflake VECTOR columns', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await dest.loadAndFinalize(
      'test_schema',
      'embeddings',
      '/tmp/data.jsonl',
      vectorColumns,
      'append',
      []
    );

    const copyCall = vi
      .mocked(conn.execute)
      .mock.calls.find((c) => c[0].sqlText.includes('COPY INTO'));
    expect(copyCall![0].sqlText).toContain('$1:"embedding"::ARRAY::VECTOR(FLOAT, 3)');
  });

  // ── loadAndFinalize — full_refresh ──

  it('loadAndFinalize("full_refresh") TRUNCATEs on first call then INSERT', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const calls = vi.mocked(conn.execute).mock.calls;
    const truncateCall = calls.find((c) => c[0].sqlText.includes('TRUNCATE TABLE'));
    expect(truncateCall).toBeDefined();
  });

  it('loadAndFinalize("full_refresh") uses INSERT on second call', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();

    await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'full_refresh',
      []
    );
    await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data2.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const calls = vi.mocked(conn.execute).mock.calls;
    const truncateCalls = calls.filter((c) => c[0].sqlText.includes('TRUNCATE TABLE'));
    expect(truncateCalls).toHaveLength(1); // Only truncated once
  });

  it('rechecks ownership inside a full_refresh TRUNCATE retry', async () => {
    const conn = createOwnedExistingConnection([
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      'marker-B',
    ]);
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: ownedMarker,
    });

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let truncateAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (sqlText.includes('TRUNCATE TABLE') && truncateAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/data.jsonl',
        issueColumns,
        'full_refresh',
        []
      )
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not owned'),
    });
    expect(truncateAttempts).toBe(1);
  });

  it('rechecks ownership inside a full_refresh COPY retry', async () => {
    const conn = createOwnedExistingConnection([
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      'marker-B',
    ]);
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: ownedMarker,
    });

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let copyAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (sqlText.includes('COPY INTO') && copyAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.loadAndFinalize(
        'test_schema',
        'issues',
        '/tmp/data.jsonl',
        issueColumns,
        'full_refresh',
        []
      )
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not owned'),
    });
    expect(copyAttempts).toBe(1);
  });

  // ── loadAndFinalize — merge ──

  it('loadAndFinalize("merge") uploads to stage, runs MERGE INTO, cleans up', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const mergeCall = calls.find((c) => c[0].sqlText.includes('MERGE INTO'));
    expect(mergeCall).toBeDefined();

    const dropCall = calls.find((c) => c[0].sqlText.includes('DROP TABLE IF EXISTS'));
    expect(dropCall).toBeDefined();
  });

  it('rechecks ownership inside merge staging COPY retries', async () => {
    const conn = createOwnedExistingConnection([
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      'marker-B',
    ]);
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: ownedMarker,
    });

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let stagingCopyAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (
        sqlText.includes('COPY INTO') &&
        sqlText.includes('_DOGSLED_STG_') &&
        stagingCopyAttempts++ === 0
      ) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
        'id',
      ])
    ).rejects.toThrow(/not owned/);
    expect(stagingCopyAttempts).toBe(1);
  });

  it('rechecks ownership inside MERGE retries before mutating the target', async () => {
    const conn = createOwnedExistingConnection([
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      'marker-B',
    ]);
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: ownedMarker,
    });

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let mergeAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (sqlText.includes('MERGE INTO') && mergeAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
        'id',
      ])
    ).rejects.toThrow(/not owned/);
    expect(mergeAttempts).toBe(1);
  });

  it('loadAndFinalize("merge") reports inserts from the MERGE summary on a fresh/empty table', async () => {
    // First run into an empty target: every staged row is NOT MATCHED -> INSERT,
    // zero updates. The driver's updates-only getAffectedRows() returns 0, which
    // previously looked like silently-dropped data.
    const conn = createMergeMockConnection(
      createMockStatementResult({
        rows: [{ 'number of rows inserted': 97, 'number of rows updated': 0 }],
        affectedRows: 0,
      })
    );
    const { dest } = await createDest(conn);
    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'merge',
      ['id']
    );

    expect(result.rowsAffected).toBe(97);
  });

  it('loadAndFinalize("merge") falls back to the driver count when no summary row is returned', async () => {
    const conn = createMergeMockConnection(
      createMockStatementResult({ rows: [], affectedRows: 5 })
    );
    const { dest } = await createDest(conn);
    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'merge',
      ['id']
    );

    expect(result.rowsAffected).toBe(5);
  });

  it('loadAndFinalize("merge") staging table has UUID suffix', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createStagingCall = calls.find(
      (c) =>
        c[0].sqlText.includes('CREATE OR REPLACE TRANSIENT TABLE') &&
        c[0].sqlText.includes('_DOGSLED_STG_')
    );
    expect(createStagingCall).toBeDefined();
    // Should have UUID suffix (32 hex chars after the table name)
    expect(createStagingCall![0].sqlText).toMatch(/_DOGSLED_STG_ISSUES_[0-9a-f]{32}/i);
  });

  it('loadAndFinalize("merge") staging table DDL has proper column types', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createStagingCall = calls.find(
      (c) =>
        c[0].sqlText.includes('CREATE OR REPLACE TRANSIENT TABLE') &&
        c[0].sqlText.includes('_DOGSLED_STG_')
    );
    const sql = createStagingCall![0].sqlText;
    expect(sql).toContain('"ID" NUMBER(38,0)');
    expect(sql).toContain('"TITLE" VARCHAR');
    expect(sql).toContain('"_TIME_EXTRACTED" TIMESTAMP_TZ');
    expect(sql).toContain('"_DOGSLED_LOADED_AT" TIMESTAMP_TZ');
  });

  it('loadAndFinalize("merge") staging table is dropped even on error', async () => {
    const conn = createMockConnection({ connected: true });
    // Make the COPY INTO for staging fail
    vi.mocked(conn.execute).mockImplementation(({ sqlText }) => {
      if (sqlText.includes('COPY INTO') && sqlText.includes('_DOGSLED_STG_')) {
        return Promise.reject(new Error('COPY failed'));
      }
      return Promise.resolve(createMockStatementResult());
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
        'id',
      ])
    ).rejects.toThrow('COPY failed');

    const calls = vi.mocked(conn.execute).mock.calls;
    const dropCall = calls.find((c) => c[0].sqlText.includes('DROP TABLE IF EXISTS'));
    expect(dropCall).toBeDefined();
  });

  it('loadAndFinalize("merge") UPDATE SET includes all non-key columns', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const mergeCall = calls.find((c) => c[0].sqlText.includes('MERGE INTO'));
    const sql = mergeCall![0].sqlText;
    // UPDATE SET should include title (non-key) but not id (key)
    expect(sql).toContain('"TITLE" = S."TITLE"');
    expect(sql).not.toMatch(/UPDATE SET[^W]*"ID" = S\."ID"/);
    // System columns should be in UPDATE SET
    expect(sql).toContain('"_TIME_EXTRACTED" = S."_TIME_EXTRACTED"');
    expect(sql).toContain('"_DOGSLED_LOADED_AT" = S."_DOGSLED_LOADED_AT"');
  });

  it('loadAndFinalize("merge") INSERT includes all columns', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const mergeCall = calls.find((c) => c[0].sqlText.includes('MERGE INTO'));
    const sql = mergeCall![0].sqlText;
    // INSERT should include all columns
    expect(sql).toMatch(
      /INSERT\s*\([^)]*"ID"[^)]*"TITLE"[^)]*"_TIME_EXTRACTED"[^)]*"_DOGSLED_LOADED_AT"/
    );
  });

  it('loadAndFinalize("merge") uses NULLS LAST in ROW_NUMBER for safe dedup', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const mergeCall = calls.find((c) => c[0].sqlText.includes('MERGE INTO'));
    const sql = mergeCall![0].sqlText;
    expect(sql).toContain('DESC NULLS LAST');
  });

  it('loadAndFinalize("merge") time guard handles NULL _time_extracted on target', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const mergeCall = calls.find((c) => c[0].sqlText.includes('MERGE INTO'));
    const sql = mergeCall![0].sqlText;
    // Should handle NULL target _time_extracted with OR ... IS NULL
    expect(sql).toContain('IS NULL');
    expect(sql).toMatch(/OR T\."_TIME_EXTRACTED" IS NULL/);
  });

  it('loadAndFinalize("merge") composite key ON clause joins all keys with AND', async () => {
    const columns: SchemaColumn[] = [
      { name: 'org_id', type: 'integer', primary_key: true },
      { name: 'user_id', type: 'integer', primary_key: true },
      { name: 'name', type: 'string' },
    ];
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'members', '/tmp/data.jsonl', columns, 'merge', [
      'org_id',
      'user_id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const mergeCall = calls.find((c) => c[0].sqlText.includes('MERGE INTO'));
    const sql = mergeCall![0].sqlText;
    expect(sql).toContain('T."ORG_ID" = S."ORG_ID" AND T."USER_ID" = S."USER_ID"');
  });

  it('loadAndFinalize("merge") cleans up staging table', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const dropCall = calls.find(
      (c) => c[0].sqlText.includes('DROP TABLE IF EXISTS') && c[0].sqlText.includes('_DOGSLED_STG_')
    );
    expect(dropCall).toBeDefined();
  });

  it('loadAndFinalize("merge") cleans up staging file', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const removeCall = calls.find((c) => c[0].sqlText.includes('REMOVE'));
    expect(removeCall).toBeDefined();
    // For merge, uploads go to the staging table's internal stage (Snowflake
    // blocks cross-table stage access), so the cleanup REMOVE targets
    // `@%_DOGSLED_STG_<table>_<uuid>/data.jsonl`, not `@%<table>/…`.
    expect(removeCall![0].sqlText).toMatch(/REMOVE @%_DOGSLED_STG_issues_[a-f0-9]+\/data\.jsonl/);
  });

  it('loadAndFinalize("merge") requires at least one key column', async () => {
    const { dest } = await createDest();
    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [])
    ).rejects.toThrow('merge strategy requires at least one key column');
  });

  // ── Connection lifecycle ──

  it('close() destroys the connection', async () => {
    const conn = createMockConnection({ connected: true });
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.close();

    expect(conn.destroy).toHaveBeenCalled();
  });

  it('getTruncatedTables() returns a defensive copy', async () => {
    const { dest } = await createDest();
    await dest.initialize();

    await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const tables = dest.getTruncatedTables();
    expect(tables.size).toBe(1);
    // Mutating the returned set should not affect the destination
    tables.clear();
    expect(dest.getTruncatedTables().size).toBe(1);
  });

  it('setTruncatedTables() initializes from checkpoint', async () => {
    const { dest } = await createDest();
    await dest.initialize();

    dest.setTruncatedTables(new Set(['TEST_SCHEMA.ISSUES']));
    expect(dest.getTruncatedTables().has('TEST_SCHEMA.ISSUES')).toBe(true);
  });

  // ── Type mapping ──

  it('type mapping: integer -> NUMBER(38,0)', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('s', 't', [{ name: 'col', type: 'integer' }]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createCall![0].sqlText).toContain('"COL" NUMBER(38,0)');
  });

  it('type mapping: number -> FLOAT', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('s', 't', [{ name: 'col', type: 'number' }]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createCall![0].sqlText).toContain('"COL" FLOAT');
  });

  it('type mapping: boolean -> BOOLEAN', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('s', 't', [{ name: 'col', type: 'boolean' }]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createCall![0].sqlText).toContain('"COL" BOOLEAN');
  });

  it('type mapping: timestamp -> TIMESTAMP_TZ', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('s', 't', [{ name: 'col', type: 'timestamp' }]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createCall![0].sqlText).toContain('"COL" TIMESTAMP_TZ');
  });

  it('type mapping: string -> VARCHAR', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('s', 't', [{ name: 'col', type: 'string' }]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createCall![0].sqlText).toContain('"COL" VARCHAR');
  });

  it('type mapping: array -> VARCHAR', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('s', 't', [{ name: 'col', type: 'array' }]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createCall![0].sqlText).toContain('"COL" VARCHAR');
  });

  it('type mapping: object -> VARCHAR', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('s', 't', [{ name: 'col', type: 'object' }]);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    expect(createCall![0].sqlText).toContain('"COL" VARCHAR');
  });

  // ── Error cases ──

  it('loadAndFinalize throws when upload fails', async () => {
    const conn = createMockConnection({ connected: true });
    vi.mocked(conn.uploadFile).mockRejectedValue(new Error('Upload failed'));
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'append', [])
    ).rejects.toThrow('Upload failed');
  });

  it('cancels an owned destination before any subsequent load mutation', async () => {
    const conn = createMockConnection({ connected: true, schemaExists: true });
    const { dest } = await createDest(conn);
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns, {
      tableOwnershipMarker: 'temp-dataset-123',
    });

    await dest.cancel();
    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'append', [])
    ).rejects.toThrow(/cancelled/i);
    expect(conn.uploadFile).not.toHaveBeenCalled();
  });

  it('loadAndFinalize throws when COPY INTO fails', async () => {
    const conn = createMockConnection({ connected: true });
    vi.mocked(conn.execute).mockImplementation(({ sqlText }) => {
      if (sqlText.includes('COPY INTO')) {
        return Promise.reject(new Error('COPY failed'));
      }
      return Promise.resolve(createMockStatementResult());
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_schema', 'issues', '/tmp/data.jsonl', issueColumns, 'append', [])
    ).rejects.toThrow('COPY failed');
  });

  it('retries a transient Snowflake COPY failure before surfacing success', async () => {
    const conn = createMockConnection({ connected: true });
    let copyAttempts = 0;
    vi.mocked(conn.execute).mockImplementation(({ sqlText }) => {
      if (sqlText.includes('COPY INTO') && copyAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return Promise.resolve(createMockStatementResult({ affectedRows: 4 }));
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_schema',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    expect(result.rowsAffected).toBe(4);
    expect(copyAttempts).toBe(2);
  });

  it('loadFromUri() truncates and copies Parquet files from object storage', async () => {
    const conn = createMockConnection({ connected: true });
    vi.mocked(conn.execute).mockImplementation(({ sqlText }) => {
      if (sqlText.includes('.INFORMATION_SCHEMA.COLUMNS')) {
        return Promise.resolve(createMockStatementResult({ rows: [] }));
      }
      if (sqlText.includes('COPY INTO')) {
        return Promise.resolve(createMockStatementResult({ affectedRows: 7 }));
      }
      return Promise.resolve(createMockStatementResult());
    });
    const { dest } = await createDest(conn);
    await dest.initialize();

    const result = await dest.loadFromUri(
      'test_schema',
      'issues',
      ['s3://stage/run/*.parquet'],
      issueColumns
    );

    const sql = vi.mocked(conn.execute).mock.calls.map((call) => call[0].sqlText);
    expect(
      sql.some((statement) => statement.includes('TRUNCATE TABLE "TEST_SCHEMA"."ISSUES"'))
    ).toBe(true);
    expect(
      sql.some(
        (statement) =>
          statement.includes('COPY INTO "TEST_SCHEMA"."ISSUES" FROM') &&
          statement.includes("'s3://stage/run/*.parquet'") &&
          statement.includes('TYPE = PARQUET')
      )
    ).toBe(true);
    expect(result.rowsAffected).toBe(7);
  });

  it('rechecks ownership inside URI TRUNCATE retries', async () => {
    const conn = createOwnedExistingConnection([ownedMarker, ownedMarker, ownedMarker, 'marker-B']);
    const { dest } = await createDest(conn);
    await dest.initialize();

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let truncateAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (sqlText.includes('TRUNCATE TABLE') && truncateAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.loadFromUri('test_schema', 'issues', ['s3://stage/run/*.parquet'], issueColumns, {
        tableOwnershipMarker: ownedMarker,
      })
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not owned'),
    });
    expect(truncateAttempts).toBe(1);
  });

  it('rechecks ownership inside URI COPY retries before loading the target', async () => {
    const conn = createOwnedExistingConnection([
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      ownedMarker,
      'marker-B',
    ]);
    const { dest } = await createDest(conn);
    await dest.initialize();

    const execute = vi.mocked(conn.execute);
    const baseExecute = execute.getMockImplementation()!;
    let copyAttempts = 0;
    execute.mockImplementation(({ sqlText }) => {
      if (sqlText.includes('COPY INTO') && copyAttempts++ === 0) {
        return Promise.reject(
          Object.assign(new Error('warehouse connection reset'), { code: 'ECONNRESET' })
        );
      }
      return baseExecute({ sqlText });
    });

    await expect(
      dest.loadFromUri('test_schema', 'issues', ['s3://stage/run/*.parquet'], issueColumns, {
        tableOwnershipMarker: ownedMarker,
      })
    ).rejects.toThrow(/not owned/);
    expect(copyAttempts).toBe(1);
  });

  // ── Validation ──

  it('ensureTable() rejects invalid schema names', async () => {
    const { dest } = await createDest();
    await dest.initialize();

    await expect(dest.ensureTable('invalid-schema!', 'issues', issueColumns)).rejects.toThrow(
      'Invalid schema name'
    );
  });

  it('ensureTable() rejects invalid table names', async () => {
    const { dest } = await createDest();
    await dest.initialize();

    await expect(dest.ensureTable('test_schema', 'invalid table!', issueColumns)).rejects.toThrow(
      'Invalid table name'
    );
  });

  // ── System columns ──

  it('system columns _time_extracted and _dogsled_loaded_at are TIMESTAMP_TZ', async () => {
    const { dest, conn } = await createDest();
    await dest.initialize();
    await dest.ensureTable('test_schema', 'issues', issueColumns);

    const calls = vi.mocked(conn.execute).mock.calls;
    const createCall = calls.find((c) => c[0].sqlText.includes('CREATE TABLE'));
    const sql = createCall![0].sqlText;
    expect(sql).toContain('"_TIME_EXTRACTED" TIMESTAMP_TZ');
    expect(sql).toContain('"_DOGSLED_LOADED_AT" TIMESTAMP_TZ');
  });
});
