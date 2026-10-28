import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import {
  EnvSecretResolver,
  IntegrationFileSchema,
  interpolateSecrets,
  resolveRunner,
} from '@bobsled-inc/connections';
import { createWarehouseAgenticCursorStore } from '../../../src/agentic/warehouse-cursors.js';
import { digestAgenticState } from '../../../src/agentic/state.js';
import { caseName, quoteIdentifier } from '../../../src/compiler/dialect.js';

const integrationPath = process.env.DOGSLED_MODEL_SPEC_CHECKPOINT_INTEGRATION;
const schema = process.env.DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA;

it.skipIf(!integrationPath && !schema)(
  'persists shared warehouse cursors across batches',
  async () => {
    if (!integrationPath || !schema) {
      throw new Error(
        'Set DOGSLED_MODEL_SPEC_CHECKPOINT_INTEGRATION and DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA'
      );
    }
    const integration = IntegrationFileSchema.parse(
      await interpolateSecrets(
        parse(await readFile(integrationPath, 'utf8')),
        new EnvSecretResolver()
      )
    );
    if (integration.source_type === 'duckdb' || integration.source_type === 'clickhouse') {
      throw new Error('Use a transactional warehouse test integration');
    }
    const catalog =
      integration.source_type === 'snowflake'
        ? integration.connection?.database
        : integration.source_type === 'bigquery'
          ? integration.connection.project_id
          : integration.source_type === 'databricks'
            ? integration.connection.catalog
            : undefined;
    const q = (name: string) =>
      quoteIdentifier(caseName(name, integration.source_type), integration.source_type);
    const table = [...(catalog ? [catalog] : []), schema, '__dogsled_cursors'].map(q).join('.');
    const key = { scope: 'cursor-integration-test', model: randomUUID(), target: 'cursor-test' };
    const signature = 'a'.repeat(64);
    const store = createWarehouseAgenticCursorStore(integration, { schema });
    let initialized = false;
    try {
      expect(await store.begin(key, signature, 'one')).toEqual({});
      initialized = true;
      await store.commit(key, signature, 'one', { pairs: 10 });
      const reopened = createWarehouseAgenticCursorStore(integration, { schema });
      expect(await reopened.begin(key, signature, 'two')).toEqual({ pairs: 10 });
      await expect(store.begin(key, signature, 'other')).rejects.toThrow();
      await reopened.commit(key, signature, 'two', { pairs: 20 });
      expect(await store.begin(key, signature, 'three')).toEqual({ pairs: 20 });
    } finally {
      if (initialized) {
        const runner = await resolveRunner(integration);
        try {
          const bind = integration.source_type === 'postgres' ? '$1' : '?';
          await runner.query!(`DELETE FROM ${table} WHERE ${q('key')} = ${bind}`, [
            digestAgenticState(key),
          ]);
        } finally {
          await runner.close?.();
        }
      }
    }
  },
  180_000
);
