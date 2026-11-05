import { createRequire } from 'node:module';
import { assertDriverVersion } from '@bobsled-inc/connections';
import { TextDecoder } from 'node:util';

import type { SnowflakeConnectionConfig, SnowflakeConnectionLike } from './snowflake.js';

// ESM does not expose `require` globally. snowflake-sdk is an optional
// CommonJS peer dependency, so load it only when a Snowflake destination is used.
const require = createRequire(import.meta.url);

interface SnowflakeSdkConnection {
  connect(callback: (err: Error | undefined) => void): unknown;
  execute(options: {
    sqlText: string;
    binds?: string[];
    complete: (
      err: Error | undefined,
      stmt: SnowflakeSdkStatement,
      rows?: Record<string, unknown>[]
    ) => void;
  }): unknown;
  destroy(callback: (err: Error | undefined) => void): unknown;
  isUp?(): boolean;
}

interface SnowflakeSdkStatement {
  getNumUpdatedRows?(): number | undefined;
  getColumns?(): Array<{ getName(): string; getType(): string }> | undefined;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function isCanonicalBase64UrlSegment(segment: string): boolean {
  if (!segment || segment.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return false;
  }

  const remainder = segment.length % 4;
  if (remainder === 0) return true;

  const lastIndex = BASE64URL_ALPHABET.indexOf(segment.at(-1)!);
  const unusedBits = remainder === 2 ? 4 : 2;
  return (lastIndex & ((1 << unusedBits) - 1)) === 0;
}

export function validateSnowflakeWorkloadIdentityToken(token: string, now: number): number {
  if (token.includes('\r') || token.includes('\n')) {
    throw new Error('Snowflake workload identity token must not contain CR or LF characters.');
  }

  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new Error('Snowflake workload identity token must contain exactly three JWT segments.');
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (!headerSegment || !isCanonicalBase64UrlSegment(headerSegment)) {
    throw new Error('Snowflake workload identity token has an invalid Base64URL header.');
  }
  if (!payloadSegment || !isCanonicalBase64UrlSegment(payloadSegment)) {
    throw new Error('Snowflake workload identity token has an invalid Base64URL payload.');
  }
  if (!signatureSegment || !isCanonicalBase64UrlSegment(signatureSegment)) {
    throw new Error('Snowflake workload identity token has an invalid Base64URL signature.');
  }

  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(headerSegment, 'base64url'))
    );
  } catch {
    throw new Error('Snowflake workload identity token has an invalid JWT header.');
  }

  const algorithm =
    header && typeof header === 'object' && !Array.isArray(header)
      ? (header as { alg?: unknown }).alg
      : undefined;
  if (
    typeof algorithm !== 'string' ||
    algorithm.trim().length === 0 ||
    algorithm.trim().toLowerCase() === 'none'
  ) {
    throw new Error(
      'Snowflake workload identity token must contain a non-empty JOSE alg other than none.'
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Snowflake workload identity token has an invalid JWT payload.');
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Number.isSafeInteger((payload as { exp?: unknown }).exp)
  ) {
    throw new Error('Snowflake workload identity token must contain a safe-integer exp claim.');
  }

  const expiresAt = (payload as { exp: number }).exp;
  if (expiresAt <= now) {
    throw new Error('Snowflake workload identity token is expired.');
  }
  return expiresAt;
}

export function validateSnowflakeWorkloadIdentityConfiguration(options: {
  token?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  accessToken?: string;
  tokenProviderConfigured: boolean;
  authenticatorConfigured?: 'OAUTH' | 'SNOWFLAKE_JWT';
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthTokenUrl?: string;
}): void {
  if (!options.token) return;

  const conflicts: string[] = [];
  if (options.password !== undefined) conflicts.push('password');
  if (options.privateKeyPath !== undefined || options.privateKeyPassphrase !== undefined) {
    conflicts.push('private key fields');
  }
  if (options.accessToken !== undefined) conflicts.push('access token');
  if (options.tokenProviderConfigured) conflicts.push('token provider');
  if (
    options.oauthClientId !== undefined ||
    options.oauthClientSecret !== undefined ||
    options.oauthTokenUrl !== undefined
  ) {
    conflicts.push('OAuth fields');
  }
  if (options.authenticatorConfigured !== undefined) conflicts.push('authenticator');

  if (conflicts.length > 0) {
    throw new Error(
      `Snowflake workload identity token cannot be combined with ${conflicts.join(', ')}.`
    );
  }
}

export function assertSnowflakeWorkloadIdentityUsable(options: {
  expiresAt?: number;
  now: number;
  connection?: Pick<SnowflakeConnectionLike, 'isClosed'> | null;
}): void {
  if (options.expiresAt === undefined || options.now >= options.expiresAt) {
    throw new Error(
      'Snowflake workload identity token expired; retry the Dogsled attempt with a current token.'
    );
  }
  if (options.connection && options.connection.isClosed()) {
    throw new Error(
      'Snowflake workload identity connection is closed; retry the Dogsled attempt with a current token.'
    );
  }
}

export function sanitizeSnowflakeConnection(
  connection: SnowflakeConnectionLike,
  sanitizeError: (error: unknown) => Error
): SnowflakeConnectionLike {
  return {
    connect: async () => {
      try {
        await connection.connect();
      } catch (error) {
        throw sanitizeError(error);
      }
    },
    execute: async (options) => {
      try {
        return await connection.execute(options);
      } catch (error) {
        throw sanitizeError(error);
      }
    },
    uploadFile: async (options) => {
      try {
        return await connection.uploadFile(options);
      } catch (error) {
        throw sanitizeError(error);
      }
    },
    isClosed: () => {
      try {
        return connection.isClosed();
      } catch (error) {
        throw sanitizeError(error);
      }
    },
    destroy: async () => {
      try {
        await connection.destroy();
      } catch (error) {
        throw sanitizeError(error);
      }
    },
  };
}

export function createSnowflakeSdkConnection(
  config: SnowflakeConnectionConfig,
  sanitizeError: (error: unknown) => Error
): SnowflakeConnectionLike {
  let raw: SnowflakeSdkConnection;
  assertDriverVersion('snowflake-sdk', '3.4.0', require);
  try {
    const snowflake = require('snowflake-sdk');
    // snowflake-sdk uses `privateKeyPath` + `privateKeyPass`, not
    // `privateKeyPassphrase`; the SDK reads and decrypts the PEM itself.
    raw = snowflake.createConnection({
      account: config.account,
      username: config.username,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      privateKeyPass: config.privateKeyPassphrase,
      authenticator: config.authenticator,
      token: config.token,
      workloadIdentityProvider: config.workloadIdentityProvider,
      warehouse: config.warehouse,
      database: config.database,
      schema: config.schema,
      role: config.role,
      ...(config.queryTag === undefined ? {} : { queryTag: config.queryTag }),
    });
  } catch (error) {
    const message = sanitizeError(error).message;
    throw new Error(`Failed to load snowflake-sdk. Install it to use --dest snowflake. ${message}`);
  }

  // The native SDK is callback-based; adapt it to the Promise contract used by
  // the loader destination.
  return {
    connect: () =>
      new Promise((resolve, reject) => {
        raw.connect((err) => (err ? reject(sanitizeError(err)) : resolve()));
      }),
    execute: ({ sqlText, binds }) =>
      new Promise((resolve, reject) => {
        raw.execute({
          sqlText,
          ...(binds === undefined ? {} : { binds }),
          complete: (
            err: Error | undefined,
            stmt: SnowflakeSdkStatement,
            rows?: Record<string, unknown>[]
          ) => {
            if (err) return reject(sanitizeError(err));
            const fetched = rows ?? [];
            resolve({
              getRows: () => fetched,
              getAffectedRows: () =>
                typeof stmt.getNumUpdatedRows === 'function'
                  ? (stmt.getNumUpdatedRows() ?? fetched.length)
                  : fetched.length,
              getColumns: () =>
                typeof stmt.getColumns === 'function' ? (stmt.getColumns() ?? []) : [],
            });
          },
        });
      }),
    uploadFile: ({ srcPath, destLoc }) => {
      // snowflake-sdk has no native uploadFile; preserve the stage reference
      // supplied by the destination so exact mixed-case table stages remain
      // addressable as well as ordinary unquoted stages.
      const sql = `PUT 'file://${srcPath.replace(/'/g, "''")}' ${destLoc} AUTO_COMPRESS=FALSE OVERWRITE=TRUE`;
      return new Promise((resolve, reject) => {
        raw.execute({
          sqlText: sql,
          complete: (
            err: Error | undefined,
            _stmt: SnowflakeSdkStatement,
            rows?: Record<string, unknown>[]
          ) => {
            if (err) return reject(sanitizeError(err));
            const status = String(rows?.[0]?.['status'] ?? 'UPLOADED');
            resolve({ status });
          },
        });
      });
    },
    isClosed: () => (typeof raw.isUp === 'function' ? !raw.isUp() : false),
    destroy: () =>
      new Promise((resolve, reject) => {
        raw.destroy((err) => (err ? reject(sanitizeError(err)) : resolve()));
      }),
  };
}
