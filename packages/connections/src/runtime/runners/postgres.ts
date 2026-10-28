import { assertDriverVersion } from '../driver-version.js';
import { createRequire } from 'node:module';
/**
 * Built-in Postgres runner.
 *
 * Auth variants: `password`, `iam`.
 *
 * Uses `pg.Client` (single connection, not Pool) since runners are
 * single-connection by design. The driver supports ESM import.
 */

import { CommandError } from '@bobsled-inc/protocol';

import type { PostgresIntegration } from '../../schemas/integration.js';
import { runCancellable } from '../cancellation.js';
import type { SqlExecOptions, SqlParams, SqlRunnerModule, SqlRunResult } from '../types.js';

// ---------------------------------------------------------------------------
// Structural driver interface — compiles without `pg` installed
// ---------------------------------------------------------------------------

interface PgClientLike {
  connect(): Promise<void>;
  query(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  /**
   * Backend process id of this session, populated on connect from the server's
   * BackendKeyData message (`pg/lib/client.js` — `_handleBackendKeyData`). It is
   * the argument the cancel path passes to `pg_cancel_backend`.
   */
  processID?: number | null;
  end(): Promise<void>;
}

interface PgClientConstructor {
  new (config: Record<string, unknown>): PgClientLike;
}

interface PgTypeRegistry {
  setTypeParser(oid: number, parser: (value: string) => unknown): void;
}

interface PgModule {
  Client: PgClientConstructor;
  types?: PgTypeRegistry;
}

// ---------------------------------------------------------------------------
// Driver loader
// ---------------------------------------------------------------------------

// Postgres OIDs the driver coerces to lossy JS types by default. We override
// with identity parsers so values arrive as raw strings, preserving:
//   - 20   (int8)        — full precision above 2^53
//   - 1700 (numeric)     — arbitrary-precision decimal
//   - 1114 (timestamp)   — microsecond precision lost by JS Date
//   - 1184 (timestamptz) — timezone offset lost by JS Date.toISOString()
// Downstream consumers (cross-warehouse staging, JSONL serialization) can
// then forward the raw string verbatim and let the destination warehouse
// CAST back to the appropriate native type without precision loss.
const PG_RAW_STRING_OIDS = [20, 1184, 1114, 1700] as const;
let pgTypeParsersInstalled = false;

async function loadPg(): Promise<PgModule> {
  assertDriverVersion('pg', '8.4.0', createRequire(import.meta.url));
  try {
    const pg = (await import('pg')) as unknown as PgModule;
    if (!pgTypeParsersInstalled && pg.types?.setTypeParser) {
      for (const oid of PG_RAW_STRING_OIDS) {
        pg.types.setTypeParser(oid, (value: string) => value);
      }
      pgTypeParsersInstalled = true;
    }
    return pg;
  } catch (err) {
    throw new CommandError(
      'pg is required for the built-in Postgres runner but is not ' +
        'installed. Add it to your project dependencies to use this runner. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildPostgresRunnerOptions {
  /** Override the pg Client instance (for tests). */
  client?: PgClientLike;
  /**
   * Override how the cancel path opens its side connection (for tests). Receives
   * the resolved connection config the runner built for the primary client —
   * `undefined` when `client` was injected, since there is no config to clone.
   * Lets a test observe the `pg_cancel_backend` round-trip without a live server.
   */
  createSideClient?: (config: Record<string, unknown> | undefined) => PgClientLike;
}

export async function buildPostgresRunner(
  integration: PostgresIntegration,
  options?: BuildPostgresRunnerOptions
): Promise<SqlRunnerModule> {
  const { connection, auth } = integration;
  if (
    auth.type === 'iam' &&
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.rds\.amazonaws\.com(?:\.cn)?$/i.test(connection.host ?? '')
  ) {
    throw new CommandError(
      'Postgres IAM authentication requires an AWS RDS endpoint. Custom hosts require password authentication with declared auth_env_vars.',
      2
    );
  }

  let client: PgClientLike;
  /**
   * The resolved connection config, captured so the cancel path can open a
   * SECOND connection with the same credentials. Undefined when the caller
   * injected `options.client` — there is nothing to clone from in that case.
   */
  let config: Record<string, unknown> | undefined;
  let ClientCtor: PgClientConstructor | undefined;

  if (options?.client) {
    client = options.client;
  } else {
    const pg = await loadPg();
    ClientCtor = pg.Client;
    config = {
      host: connection.host,
      port: connection.port,
      database: connection.database,
      application_name: connection.application_name ?? 'dogsled-model-spec',
    };

    if (connection.ssl?.mode === 'disable') {
      config['ssl'] = false;
    } else if (connection.ssl) {
      const sslConfig: Record<string, unknown> = {};
      if (connection.ssl.mode) {
        sslConfig['rejectUnauthorized'] =
          connection.ssl.mode === 'verify-full' || connection.ssl.mode === 'verify-ca';
      }
      if (connection.ssl.ca_cert) {
        sslConfig['ca'] = connection.ssl.ca_cert;
      }
      config['ssl'] = sslConfig;
    }

    if (auth.type === 'password') {
      config['user'] = auth.user;
      config['password'] = auth.password;
    } else if (auth.type === 'iam') {
      config['user'] = auth.user;
      // IAM auth: the password is a short-lived token generated by the AWS SDK
      // at connect time. We dynamically import @aws-sdk/rds-signer and use a
      // structural cast so this module compiles without the SDK installed.
      try {
        const signerMod = (await import('@aws-sdk/rds-signer' as string)) as {
          Signer: new (config: {
            hostname: string;
            port: number;
            username: string;
            region: string;
          }) => { getAuthToken(): Promise<string> };
        };
        const signer = new signerMod.Signer({
          hostname: connection.host!,
          port: connection.port,
          username: auth.user!,
          region: auth.region,
        });
        config['password'] = await signer.getAuthToken();
        // IAM auth requires SSL
        if (!config['ssl']) config['ssl'] = { rejectUnauthorized: true };
      } catch (err) {
        throw new CommandError(
          '@aws-sdk/rds-signer is required for Postgres IAM auth but is not installed. ' +
            `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
          1
        );
      }
    }

    client = new pg.Client(config);
  }

  await client.connect();

  // Set search_path if a default schema is configured
  if (connection.schema) {
    await client.query(`SET search_path TO "${connection.schema.replace(/"/g, '""')}"`);
  }

  /**
   * Open the connection the cancel request travels on. Returns `undefined` when
   * there is nothing to open — the caller injected `options.client`, so we never
   * built a config to clone. The cancel path treats that as failed delivery and
   * terminates the primary connection so the active query still settles.
   */
  const openSideClient = (): PgClientLike | undefined => {
    if (options?.createSideClient) return options.createSideClient(config);
    if (config === undefined || ClientCtor === undefined) return undefined;
    return new ClientCtor(config);
  };

  /**
   * `pg` exposes no per-query abort option, so the only way to stop a statement
   * already in flight is the Postgres protocol's out-of-band CancelRequest. We
   * reach it via `pg_cancel_backend(pid)` on a SECOND, short-lived connection:
   * the primary connection is blocked waiting on the very query we want to kill,
   * so it cannot carry the request, and the side-connection route needs no
   * access to pg internals.
   */
  const cancelBackend = async (): Promise<void> => {
    const pid = client.processID;
    let deliveryError: unknown;
    if (typeof pid !== 'number') {
      deliveryError = new Error('Postgres driver did not expose the active backend process id.');
    }
    const side = deliveryError === undefined ? openSideClient() : undefined;
    if (deliveryError === undefined && !side) {
      deliveryError = new Error('Postgres cancellation requires a side connection.');
    }
    if (deliveryError === undefined && side) {
      try {
        await side.connect();
        const result = await side.query('SELECT pg_cancel_backend($1)', [pid!]);
        if (result.rows[0]?.['pg_cancel_backend'] !== true) {
          throw new Error(`Postgres backend ${pid!} rejected the cancellation request.`);
        }
      } catch (error) {
        deliveryError = error;
      } finally {
        await side.end().catch(() => {});
      }
    }
    if (deliveryError !== undefined) {
      // If the protocol-level CancelRequest could not be delivered, terminating
      // the primary connection is the fail-closed fallback that guarantees its
      // active query rejects instead of running forever in the background.
      try {
        await client.end();
      } catch (fallbackError) {
        throw new AggregateError(
          [deliveryError, fallbackError],
          'Postgres cancellation and connection termination both failed.'
        );
      }
      throw deliveryError;
    }
  };

  const run = async (sql: string, options?: SqlExecOptions): Promise<SqlRunResult> => {
    const result = await runCancellable(options?.signal, (register) => {
      register(cancelBackend);
      return client.query(sql);
    });
    const rc = result.rowCount;
    if (typeof rc === 'number' && Number.isFinite(rc)) {
      return { rowCount: rc };
    }
    return {};
  };

  const query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
    options?: SqlExecOptions
  ): Promise<TRow[]> => {
    if (params !== undefined && !Array.isArray(params)) {
      throw new CommandError('Postgres runner only supports positional SQL bindings.', 2);
    }
    const result = await runCancellable(options?.signal, (register) => {
      register(cancelBackend);
      return client.query(sql, params);
    });
    return result.rows as TRow[];
  };

  const close = async (): Promise<void> => {
    await client.end();
  };

  return { run, query, supportsBindings: true, close };
}
