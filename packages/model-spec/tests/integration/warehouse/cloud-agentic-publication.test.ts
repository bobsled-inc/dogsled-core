import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { createLocalAgenticStateStore, executeAgenticRun } from '../../../src/agentic/index.js';
import { createSqlAgenticPublisher } from '../../../src/agentic/sql-publisher.js';
import { publicationNames } from '../../../src/agentic/sql-publication-dialect.js';
import { AGENTIC_ROW_STORE_LIMITS } from '../../../src/agentic/store-limits.js';
import { fullPublicationPayload, publishPayload } from '../../support/publication-payload.js';
import { runFixture } from '../../unit/agentic/state-fixture.js';

const integrationPath = process.env.BOBSLED_CORE_MODEL_SPEC_AGENTIC_PUBLICATION_INTEGRATION;
const namespace = process.env.BOBSLED_CORE_MODEL_SPEC_AGENTIC_PUBLICATION_SCHEMA;

describe.skipIf(!integrationPath && !namespace)('cloud agentic publication', () => {
  it('replaces processed keys and recovers a committed receipt after reopen', async () => {
    if (!integrationPath || !namespace) {
      throw new Error(
        'Set both BOBSLED_CORE_MODEL_SPEC_AGENTIC_PUBLICATION_INTEGRATION and BOBSLED_CORE_MODEL_SPEC_AGENTIC_PUBLICATION_SCHEMA'
      );
    }
    const integration = IntegrationFileSchema.parse(
      await interpolateSecrets(
        parse(await readFile(integrationPath, 'utf8')),
        new EnvSecretResolver()
      )
    );
    if (
      integration.source_type !== 'snowflake' &&
      integration.source_type !== 'bigquery' &&
      integration.source_type !== 'databricks'
    ) {
      throw new Error('Unsupported cloud integration');
    }
    const names = publicationNames(
      `${namespace}.agentic_test_${randomUUID().replaceAll('-', '')}`,
      integration.source_type
    );
    const directory = await mkdtemp(join(tmpdir(), 'agentic-cloud-'));
    const operationIds = new Set<string>();
    const publishers: Awaited<ReturnType<typeof createSqlAgenticPublisher>>[] = [];
    const inspect = async (sql: string) => {
      const runner = await resolveRunner(integration);
      try {
        const rows = await runner.query!(sql);
        return rows.map((row) =>
          Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]))
        );
      } finally {
        await runner.close?.();
      }
    };
    try {
      const publisher = await createSqlAgenticPublisher(integration);
      publishers.push(publisher);
      const recordingPublisher = {
        ...publisher,
        prepare: async (...args: Parameters<typeof publisher.prepare>) => {
          operationIds.add(args[1].operation_id);
          return publisher.prepare(...args);
        },
      };
      const f = runFixture(2);
      f.host.supportedDialects = [integration.source_type];
      const context = () => ({ ...f.context(), target: names.target });
      f.host.executeAgent = vi.fn(
        async ({ assignment }: Parameters<typeof f.host.executeAgent>[0]) => ({
          contract_version: 2 as const,
          attempt_id: assignment.attempt_id,
          status: 'succeeded' as const,
          usage: { status: 'unknown' as const, reason: 'unavailable' },
          rows: [
            {
              pair_id: assignment.input.rows[0]!.pair_id,
              assessment: "first ' finding",
              _bobsled_evidence: null,
              _bobsled_confidence: null,
              _bobsled_reason: null,
            },
          ],
        })
      );
      const local = createLocalAgenticStateStore(directory);
      let confirmationInterrupted = false;
      const failConfirmation = {
        async acquire(key: Parameters<typeof local.acquire>[0]) {
          const session = await local.acquire(key);
          return {
            ...session,
            checkpoint: async (command: Parameters<typeof session.checkpoint>[0]) => {
              if (command.type === 'confirm_publication') {
                confirmationInterrupted = true;
                throw new Error('test: local confirmation unavailable');
              }
              return session.checkpoint(command);
            },
          };
        },
      };
      await expect(
        executeAgenticRun(f.host, context(), {
          run: { id: 'first', mode: 'start' },
          projectDirectory: directory,
          stateStore: failConfirmation,
          publisher: recordingPublisher,
        })
      ).rejects.toThrow('Agentic state corrupt');
      expect(confirmationInterrupted).toBe(true);
      await publisher.close();
      const reopened = await createSqlAgenticPublisher(integration);
      publishers.push(reopened);
      expect(
        (
          await executeAgenticRun(f.host, context(), {
            run: { id: 'first', mode: 'resume' },
            projectDirectory: directory,
            publisher: reopened,
          })
        ).publication
      ).toBe('confirmed');
      expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
      expect(Number((await inspect(`SELECT COUNT(*) AS n FROM ${names.receipts}`))[0]?.n)).toBe(1);
      f.host.prepare = async () => [{ pair_id: 'p0' }];
      f.host.executeAgent = async ({ assignment }) => ({
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage: { status: 'unknown', reason: 'unavailable' },
        rows: [],
      });
      expect(
        (
          await executeAgenticRun(f.host, context(), {
            run: { id: 'second', mode: 'start' },
            projectDirectory: directory,
            publisher: {
              ...reopened,
              prepare: async (...args: Parameters<typeof reopened.prepare>) => {
                operationIds.add(args[1].operation_id);
                return reopened.prepare(...args);
              },
            },
          })
        ).publication
      ).toBe('confirmed');
      expect(
        await inspect(`SELECT pair_id, assessment, _bobsled_run_id FROM ${names.target}`)
      ).toEqual([{ pair_id: 'p1', assessment: "first ' finding", _bobsled_run_id: 'first' }]);
      expect(Number((await inspect(`SELECT COUNT(*) AS n FROM ${names.receipts}`))[0]?.n)).toBe(2);

      if (integration.source_type === 'snowflake') {
        const payload = fullPublicationPayload(context());
        operationIds.add(payload.identity.operation_id);
        const receipt = await publishPayload(
          reopened,
          context(),
          payload,
          AGENTIC_ROW_STORE_LIMITS
        );
        expect(receipt.committed_version).toBe(3);
        const [row] = await inspect(
          `SELECT COUNT(*) AS n, SUM(OCTET_LENGTH(assessment)) AS bytes FROM ${names.target}`
        );
        expect(Number(row?.n)).toBe(10_000);
        expect(Number(row?.bytes)).toBe(
          payload.rows.reduce((total, row) => total + Buffer.byteLength(row.assessment), 0)
        );
      }
    } finally {
      for (const publisher of publishers) await publisher.close();
      const tables = [...operationIds].flatMap((id) => [names.stage(id), names.stage(id, '_k')]);
      tables.push(names.target, names.manifests, names.receipts, names.control);
      const runner = await resolveRunner(integration);
      try {
        for (const table of tables) await runner.run(`DROP TABLE IF EXISTS ${table}`);
      } finally {
        await runner.close?.();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 600_000);
});
