import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  EnvSecretResolver,
  IntegrationFileSchema,
  interpolateSecrets,
  resolveRunner,
} from '@bobsled-inc/connections';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { digestAgenticState } from '../../../src/agentic/state.js';
import { caseName, quoteIdentifier } from '../../../src/compiler/dialect.js';
import { runFixture } from '../../unit/agentic/state-fixture.js';

const integrationPath = process.env.BOBSLED_CORE_MODEL_SPEC_CHECKPOINT_INTEGRATION;
const schema = process.env.BOBSLED_CORE_MODEL_SPEC_CHECKPOINT_SCHEMA;

describe.skipIf(!integrationPath && !schema)('cloud checkpoint store', () => {
  it('retains accepted results and fences concurrent owners', async () => {
    if (!integrationPath || !schema) {
      throw new Error(
        'Set BOBSLED_CORE_MODEL_SPEC_CHECKPOINT_INTEGRATION and BOBSLED_CORE_MODEL_SPEC_CHECKPOINT_SCHEMA'
      );
    }
    const integration = IntegrationFileSchema.parse(
      await interpolateSecrets(
        parse(await readFile(integrationPath, 'utf8')),
        new EnvSecretResolver()
      )
    );
    if (!['snowflake', 'bigquery', 'databricks'].includes(integration.source_type)) {
      throw new Error('Use a cloud test integration');
    }
    const directory = await mkdtemp(join(tmpdir(), 'checkpoint-cloud-'));
    const f = runFixture(8);
    f.model.plan.steps[0]!.instructions = 'Synthetic checkpoint data. '.repeat(2200);
    const id = randomUUID();
    const scope = 'checkpoint-integration-test';
    const key = { scope, model: f.context().resolved.model.name, id };
    const calls = vi.spyOn(f.host, 'executeAgent');
    const store = createWarehouseCheckpointStore(integration, { schema });
    try {
      const owner = await store.acquire(key);
      try {
        await expect(store.acquire(key)).rejects.toThrow();
      } finally {
        await owner.release();
      }
      await executeAgenticRun(f.host, f.context(), {
        projectDirectory: directory,
        stateStore: store,
        run: { id, scope, mode: 'start' },
      });
      expect(calls).toHaveBeenCalledTimes(8);
      calls.mockClear();
      await executeAgenticRun(f.host, f.context(), {
        projectDirectory: directory,
        stateStore: createWarehouseCheckpointStore(integration, { schema }),
        run: { id, scope, mode: 'resume' },
      });
      expect(calls).not.toHaveBeenCalled();
      await expect(access(join(directory, '.bobsled/model-spec'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
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
      const namespace = [...(catalog ? [catalog] : []), schema].map(q).join('.');
      const runner = await resolveRunner(integration);
      try {
        for (const suffix of ['p', 'c']) {
          await runner.run(
            `DROP TABLE IF EXISTS ${namespace}.${q(`__bobsled_cp_${digestAgenticState(key).slice(0, 48)}_${suffix}`)}`
          );
        }
      } finally {
        await runner.close?.();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 300_000);
});
