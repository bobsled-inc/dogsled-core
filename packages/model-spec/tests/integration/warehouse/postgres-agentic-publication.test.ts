import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRunner, type PostgresIntegration } from '@bobsled-inc/connections';
import { createDefaultAgenticStateStore, executeAgenticRun } from '../../../src/agentic/index.js';
import { createSqlAgenticPublisher } from '../../../src/agentic/sql-publisher.js';
import { publicationNames, publicationType } from '../../../src/agentic/sql-publication-dialect.js';
import { AGENTIC_ROW_STORE_LIMITS } from '../../../src/agentic/store-limits.js';
import {
  fullPublicationPayload,
  publicationPayload,
  publishPayload,
} from '../../support/publication-payload.js';
import { runFixture } from '../../unit/agentic/state-fixture.js';

// Run against a dedicated database with BOBSLED_CORE_MODEL_SPEC_INTEGRATION_WAREHOUSE=postgres.
// Each test creates and drops its own random schema.
const enabled = process.env.BOBSLED_CORE_MODEL_SPEC_INTEGRATION_WAREHOUSE?.split(',').some((name) =>
  ['postgres', 'all'].includes(name.trim())
);
describe.skipIf(!enabled)('PostgreSQL agentic publication', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function setup() {
    for (const name of ['HOST', 'DATABASE', 'USER', 'PASSWORD']) {
      if (!process.env[`BOBSLED_CORE_MODEL_SPEC_POSTGRES_${name}`]) {
        throw new Error(`BOBSLED_CORE_MODEL_SPEC_POSTGRES_${name} is required`);
      }
    }
    const integration: PostgresIntegration = {
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'postgres',
      connection: {
        host: process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_HOST!,
        port: Number(process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_PORT ?? 5432),
        database: process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_DATABASE!,
      },
      auth: {
        type: 'password',
        user: process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_USER!,
        password: process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_PASSWORD!,
      },
    };
    const inspect = async (sql: string) => {
      const runner = await resolveRunner(integration);
      try {
        return await runner.query!(sql);
      } finally {
        await runner.close?.();
      }
    };
    const schema = `agentic_test_${randomUUID().replaceAll('-', '')}`;
    await inspect(`CREATE SCHEMA "${schema}"`);
    cleanups.push(async () => {
      await inspect(`DROP SCHEMA "${schema}" CASCADE`);
    });
    const directory = await mkdtemp(join(tmpdir(), 'agentic-postgres-'));
    cleanups.push(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const publisher = await createSqlAgenticPublisher(integration);
    cleanups.push(() => publisher.close());
    const fixture = runFixture(2);
    fixture.host.supportedDialects = ['postgres'];
    const target = `${schema}.pair_assessments`;
    const context = () => ({ ...fixture.context(), target });
    const names = publicationNames(target, 'postgres');
    // Operation stages are retained after commit; probe and key tables have suffixes.
    const stages = async () =>
      (
        await inspect(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}'`
        )
      ).filter((row) => /^_dogsled_pub_[a-f0-9]{48}$/.test(String(row.table_name))).length;
    return {
      ...fixture,
      context,
      names,
      target,
      integration,
      publisher,
      directory,
      inspect,
      stages,
    };
  }
  it('commits 10,000 rows and a 16 MiB payload', async () => {
    const f = await setup();
    try {
      const context = f.context();
      await f.publisher.preflight(context);
      // Start with a populated target so the processed-key stage is also exercised.
      await publishPayload(f.publisher, context, publicationPayload(context, 1));
      const payload = fullPublicationPayload(context);
      const receipt = await publishPayload(f.publisher, context, payload, AGENTIC_ROW_STORE_LIMITS);
      expect(receipt.committed_version).toBe(2);
      const expectedBytes = payload.rows.reduce(
        (total, row) => total + Buffer.byteLength(row.assessment),
        0
      );
      const [row] = await f.inspect(
        `SELECT COUNT(*) AS n, SUM(OCTET_LENGTH(assessment)) AS bytes FROM ${f.names.target}`
      );
      expect(Number(row?.n)).toBe(10_000);
      expect(Number(row?.bytes)).toBe(expectedBytes);
    } finally {
      await f.publisher.close();
    }
  }, 60_000);

  it('replaces explicit keys and keeps untouched rows and provenance across reopen', async () => {
    const f = await setup();
    f.host.executeAgent = async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [
        {
          pair_id: assignment.input.rows[0]!.pair_id,
          assessment: "first ' finding",
          _dogsled_evidence: null,
          _dogsled_confidence: null,
          _dogsled_reason: null,
        },
      ],
    });
    const run = (id: string) =>
      executeAgenticRun(f.host, f.context(), {
        run: { id, mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      });
    expect((await run('first')).publication).toBe('confirmed');
    f.host.prepare = async () => [{ pair_id: 'p0' }];
    expect((await run('replacement')).publication).toBe('confirmed');
    expect(
      await f.inspect(`SELECT pair_id, _dogsled_run_id FROM ${f.target} ORDER BY pair_id`)
    ).toEqual([
      { pair_id: 'p0', _dogsled_run_id: 'replacement' },
      { pair_id: 'p1', _dogsled_run_id: 'first' },
    ]);
    f.host.executeAgent = async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [],
    });
    expect((await run('second')).publication).toBe('confirmed');
    expect(await f.inspect(`SELECT pair_id, assessment, _dogsled_run_id FROM ${f.target}`)).toEqual(
      [{ pair_id: 'p1', assessment: "first ' finding", _dogsled_run_id: 'first' }]
    );
    await f.publisher.close();
  });
  it('leaves an absent target absent on empty input and creates an empty table for processed zero findings', async () => {
    const f = await setup();
    f.host.prepare = async () => [];
    await executeAgenticRun(f.host, f.context(), {
      run: { id: 'empty', mode: 'start' },
      projectDirectory: f.directory,
      publisher: f.publisher,
    });
    expect(
      await f.inspect(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = '${f.names.schema}' AND table_name = 'pair_assessments'`
      )
    ).toEqual([]);
    f.host.prepare = async () => [{ pair_id: 'p0' }];
    await executeAgenticRun(f.host, f.context(), {
      run: { id: 'zero', mode: 'start' },
      projectDirectory: f.directory,
      publisher: f.publisher,
    });
    expect(await f.inspect(`SELECT * FROM ${f.target}`)).toEqual([]);
  });

  it('rejects incompatible schema and unsafe final checks before agent calls', async () => {
    const f = await setup();
    f.host.executeAgent = vi.fn(f.host.executeAgent);
    await f.inspect(`CREATE TABLE ${f.target} (pair_id VARCHAR)`);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'schema', mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow('rebuild');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    await f.inspect(`DROP TABLE ${f.target}`);
    f.model.tests = [{ type: 'custom', sql: 'SELECT 1' }];
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'custom', mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow('custom SQL');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    f.model.tests = [{ type: 'not_null' }];
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'malformed', mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow('complete tests');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    f.model.tests = [];
    f.model.expect = [{ kind: 'row_count_between', min: 1, severity: 'warn' }];
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'warn', mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow('warning severity');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
  });

  it('checks an unchanged target in place for empty input', async () => {
    const f = await setup();
    f.host.executeAgent = async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [
        {
          pair_id: assignment.input.rows[0]!.pair_id,
          assessment: 'existing finding',
          _dogsled_evidence: null,
          _dogsled_confidence: null,
          _dogsled_reason: null,
        },
      ],
    });
    const run = (id: string) =>
      executeAgenticRun(f.host, f.context(), {
        run: { id, mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      });
    await run('populate');
    const rows = await f.inspect(`SELECT * FROM ${f.target} ORDER BY pair_id`);
    expect(rows).toHaveLength(2);
    const staged = await f.stages();
    f.host.prepare = async () => [];
    f.model.tests = [{ type: 'unique', column: 'pair_id' }];
    f.model.expect = [{ kind: 'row_count_between', min: 2, max: 2 }];
    expect((await run('empty')).publication).toBe('confirmed');
    // The second check fails only because the existing target has two rows.
    f.model.expect = [{ kind: 'row_count_between', max: 1 }];
    await expect(run('failing')).rejects.toThrow('final check failed');
    expect(await f.inspect(`SELECT * FROM ${f.target} ORDER BY pair_id`)).toEqual(rows);
    // Neither empty run built a stage: both checked the target in place.
    expect(await f.stages()).toBe(staged);
  });

  it('stages an empty-input check when a target column uses a nondeterministic collation', async () => {
    const f = await setup();
    const collation = `"${f.names.schema}".case_insensitive`;
    await f.inspect(
      `CREATE COLLATION ${collation} (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`
    );
    const columns = f
      .context()
      .resolved.output_columns.map(
        (column) =>
          `"${column.name}" ${publicationType(column.type, 'postgres')}${column.name === 'assessment' ? ` COLLATE ${collation}` : ''}${column.nullable ? '' : ' NOT NULL'}`
      );
    await f.inspect(`CREATE TABLE ${f.target} (${columns.join(', ')})`);
    await f.inspect(
      `INSERT INTO ${f.target} (pair_id, assessment, _dogsled_run_id) VALUES ('p0', 'Valid finding', 'earlier')`
    );
    f.host.prepare = async () => [];
    // PostgreSQL rejects regular expressions on nondeterministic collations; a stage copy
    // uses the database default collation, as publications did before in-place checks.
    f.model.expect = [{ kind: 'regex', column: 'assessment', pattern: '^Valid' }];
    const result = await executeAgenticRun(f.host, f.context(), {
      run: { id: 'collated', mode: 'start' },
      projectDirectory: f.directory,
      publisher: f.publisher,
    });
    expect(result.publication).toBe('confirmed');
    expect(await f.inspect(`SELECT pair_id, assessment FROM ${f.target}`)).toEqual([
      { pair_id: 'p0', assessment: 'Valid finding' },
    ]);
    expect(await f.stages()).toBe(1);
  });

  it('stages an empty-input check when the target uses json instead of jsonb', async () => {
    const f = await setup();
    const columns = f
      .context()
      .resolved.output_columns.map(
        (column) =>
          `"${column.name}" ${publicationType(column.type, 'postgres').replace('JSONB', 'JSON')}${column.nullable ? '' : ' NOT NULL'}`
      );
    await f.inspect(`CREATE TABLE ${f.target} (${columns.join(', ')})`);
    await f.inspect(
      `INSERT INTO ${f.target} (pair_id, assessment, _dogsled_run_id, _dogsled_reason) VALUES ('p0', 'kept', 'earlier', '{"summary": "a"}'::json)`
    );
    f.host.prepare = async () => [];
    // PostgreSQL json has no equality operator; the staged jsonb copy does.
    f.model.tests = [{ type: 'unique', column: '_dogsled_reason' }];
    const result = await executeAgenticRun(f.host, f.context(), {
      run: { id: 'json', mode: 'start' },
      projectDirectory: f.directory,
      publisher: f.publisher,
    });
    expect(result.publication).toBe('confirmed');
    expect(await f.inspect(`SELECT pair_id, assessment FROM ${f.target}`)).toEqual([
      { pair_id: 'p0', assessment: 'kept' },
    ]);
  });

  it('rejects failed final checks without creating the target', async () => {
    const f = await setup();
    f.model.expect = [{ kind: 'row_count_between', min: 1 }];
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'checks', mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow('final check failed');
    expect(
      await f.inspect(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = '${f.names.schema}' AND table_name = 'pair_assessments'`
      )
    ).toEqual([]);
  });

  it('recovers after target commit before state confirmation with both stores reopened', async () => {
    const f = await setup();
    const local = createDefaultAgenticStateStore(f.directory);
    const brokenStore = {
      async acquire(key: Parameters<typeof local.acquire>[0]) {
        const session = await local.acquire(key);
        return {
          ...session,
          checkpoint: async (command: Parameters<typeof session.checkpoint>[0]) => {
            if (command.type === 'confirm_publication') throw new Error('state unavailable');
            return session.checkpoint(command);
          },
        };
      },
    };
    f.host.executeAgent = vi.fn(f.host.executeAgent);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'lost', mode: 'start' },
        projectDirectory: f.directory,
        stateStore: brokenStore,
        publisher: f.publisher,
      })
    ).rejects.toThrow();
    expect(await f.inspect(`SELECT COUNT(*) AS n FROM ${f.names.receipts}`)).toEqual([{ n: '1' }]);
    await f.publisher.close();
    const reopened = await createSqlAgenticPublisher(f.integration);
    const resumed = await executeAgenticRun(f.host, f.context(), {
      run: { id: 'lost', mode: 'resume' },
      projectDirectory: f.directory,
      publisher: reopened,
    });
    expect(resumed.publication).toBe('confirmed');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    expect(await f.inspect(`SELECT revision FROM ${f.names.control}`)).toEqual([{ revision: '1' }]);
    await reopened.close();
  });

  it('rejects a stale prepared version after another publication and rejects an obsolete fence', async () => {
    const f = await setup();
    const stopBeforeCommit = {
      ...f.publisher,
      commit: async () => {
        throw new Error('before commit');
      },
    };
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'old', mode: 'start' },
        projectDirectory: f.directory,
        publisher: stopBeforeCommit,
      })
    ).rejects.toThrow('before commit');
    const local = createDefaultAgenticStateStore(f.directory);
    const session = await local.acquire({ scope: 'lake', model: f.model.name, id: 'old' });
    const snapshot = await session.read();
    await session.release();
    const first = await f.publisher.claim(f.context().target);
    const other = await createSqlAgenticPublisher(f.integration);
    await other.claim(f.context().target);
    await expect(f.publisher.commit(snapshot!.publication_intent!, first)).rejects.toThrow('Stale');
    await executeAgenticRun(f.host, f.context(), {
      run: { id: 'new', mode: 'start' },
      projectDirectory: f.directory,
      publisher: other,
    });
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'old', mode: 'resume' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow('Stale');
    expect(await f.inspect(`SELECT revision FROM ${f.names.control}`)).toEqual([{ revision: '1' }]);
    await other.close();
  });
});
