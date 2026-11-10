import { defineConfig } from 'tsup';

/**
 * Runtime-only Node drivers and SDKs that pg-base-client, the file-storage
 * clients, and the warehouse-client factory load dynamically with
 * `await import('<name>')`.
 *
 * These are CJS-leaning libraries (most call `require('events')` /
 * `require('child_process')` internally). If tsup inlines them, esbuild's
 * CJS-to-ESM bridge emits a `__require` shim that resolves `require` from
 * the bundle's *evaluation* scope. Before this fix the extractor bundle
 * had no `createRequire` banner, so the inlined CJS driver evaluated and
 * the shim threw the runtime error
 *
 *     Dynamic require of "events" is not supported
 *
 * the moment a postgres extraction started. The banner below now ships a
 * real `require` in module scope as a safety net, but keeping these
 * modules external is still the right answer: it lets Node's regular
 * resolver load them at runtime from the consumer's `node_modules`,
 * shrinks the bundle dramatically (55k → 20k lines), and avoids dragging
 * native bindings through esbuild's bundler.
 *
 * Keep this list aligned with the dynamic imports in:
 *   - packages/extractor/src/runtime/pg-base-client.ts (`pg`)
 *   - packages/extractor/src/runtime/snowflake-client.ts (none — direct REST)
 *   - packages/extractor/src/runtime/bigquery-client.ts (`@google-cloud/bigquery`,
 *       `google-auth-library` for access_token / token_command auth)
 *   - packages/extractor/src/runtime/mysql-client.ts (`mysql2/promise`)
 *   - packages/extractor/src/runtime/iceberg-client.ts / delta-client.ts (`@duckdb/node-api`)
 *   - packages/extractor/src/runtime/clients/s3-file-client.ts
 *       (`@aws-sdk/client-s3`, `@aws-sdk/credential-providers`)
 *   - packages/extractor/src/runtime/clients/gcs-file-client.ts
 *       (`@google-cloud/storage`, `google-auth-library`)
 *   - packages/extractor/src/runtime/clients/sftp-file-client.ts (`ssh2`)
 *   - packages/extractor/src/runtime/pg-base-client.ts (`@aws-sdk/rds-signer` for IAM)
 *
 * Adding a new dynamic-import call site? Add the module here too.
 */
const RUNTIME_DYNAMIC_DEPS = [
  '@aws-sdk/client-s3',
  '@aws-sdk/credential-providers',
  '@aws-sdk/rds-signer',
  '@clickhouse/client',
  '@databricks/sql',
  '@duckdb/node-api',
  '@google-cloud/bigquery',
  '@google-cloud/storage',
  'google-auth-library',
  'mysql2',
  'mysql2/promise',
  'pg',
  'pg-pool',
  'pg-protocol',
  'pg-types',
  'pgpass',
  'snowflake-sdk',
  'ssh2',
  'tedious',
];

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'runtime/index': 'src/runtime/index.ts',
      'resources/index': 'src/resources/index.ts',
      'core/index': 'src/framework/core/index.ts',
      'framework-runtime/index': 'src/framework/runtime/index.ts',
      'extractor/index': 'src/framework/extractor/index.ts',
      'sftp/index': 'src/runtime/sftp.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    external: RUNTIME_DYNAMIC_DEPS,
    // Belt-and-suspenders shim: if a future inlining sneaks past `external`
    // (e.g. a transitive CJS dep we didn't list), Node's real `require` is
    // still defined in module scope so esbuild's `__require` fallback won't
    // throw. Mirrors the banner Dogsled CLI's tsup config has used since the
    // ESM cutover.
    banner: {
      js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
    },
  },
]);
