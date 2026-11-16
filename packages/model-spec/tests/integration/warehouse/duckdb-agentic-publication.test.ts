import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { buildDuckDbRunner, type DuckDbIntegration } from '@bobsled-inc/connections';
import {
  createDefaultAgenticStateStore,
  createDuckDbAgenticPublisher,
  createAgentAssignmentOutputSchema,
  executeAgenticRun,
} from '../../../src/agentic/index.js';
import { AGENTIC_ROW_STORE_LIMITS } from '../../../src/agentic/store-limits.js';
import {
  fullPublicationPayload,
  publicationPayload,
  publishPayload,
} from '../../support/publication-payload.js';
import { runFixture } from '../../unit/agentic/state-fixture.js';
import { stringify } from 'yaml';
import { runProject } from '../../../src/api/index.js';
import { warehouseEnabled } from './setup.js';

const faults = vi.hoisted(() => ({ commit: '' as '' | 'before' | 'after' }));
vi.mock('@bobsled-inc/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bobsled-inc/connections')>();
  return {
    ...actual,
    buildDuckDbRunner: async (...args: Parameters<typeof actual.buildDuckDbRunner>) => {
      const runner = await actual.buildDuckDbRunner(...args);
      let hasReceipt = false;
      return {
        ...runner,
        query: async (...queryArgs: Parameters<NonNullable<typeof runner.query>>) => {
          if (queryArgs[0].startsWith('INSERT INTO "_bobsled_agentic_publication"."receipts"')) {
            hasReceipt = true;
          }
          return runner.query!(...queryArgs);
        },
        run: async (...runArgs: Parameters<typeof runner.run>) => {
          const fault = runArgs[0] === 'COMMIT' && hasReceipt ? faults.commit : '';
          if (fault) faults.commit = '';
          if (fault === 'before') throw new Error('Injected before target COMMIT');
          const result = await runner.run(...runArgs);
          if (fault === 'after') throw new Error('Injected after target COMMIT');
          return result;
        },
      };
    },
  };
});

describe.skipIf(!warehouseEnabled('duckdb'))('file-backed agentic publication', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'agentic-publish-'));
    dirs.push(directory);
    const integration: DuckDbIntegration = {
      spec_version: '1',
      type: 'integration',
      name: 'lake',
      source_type: 'duckdb',
      auth: { type: 'file', path: join(directory, 'data.duckdb') },
    };
    const publisher = await createDuckDbAgenticPublisher(integration);
    const fixture = runFixture(2);
    const inspect = async (sql: string) => {
      const runner = await buildDuckDbRunner(integration);
      try {
        return await runner.query!(sql);
      } finally {
        await runner.close!();
      }
    };
    return { ...fixture, integration, publisher, directory, inspect };
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
        `SELECT COUNT(*) AS n, SUM(OCTET_LENGTH(ENCODE(assessment))) AS bytes FROM main.pair_assessments`
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
          _bobsled_evidence: null,
          _bobsled_confidence: null,
          _bobsled_reason: null,
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
    f.host.executeAgent = async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [],
    });
    expect((await run('second')).publication).toBe('confirmed');
    expect(
      await f.inspect('SELECT pair_id, assessment, _bobsled_run_id FROM main.pair_assessments')
    ).toEqual([{ pair_id: 'p1', assessment: "first ' finding", _bobsled_run_id: 'first' }]);
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
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'pair_assessments'"
      )
    ).toEqual([]);
    f.host.prepare = async () => [{ pair_id: 'p0' }];
    await executeAgenticRun(f.host, f.context(), {
      run: { id: 'zero', mode: 'start' },
      projectDirectory: f.directory,
      publisher: f.publisher,
    });
    expect(await f.inspect('SELECT * FROM main.pair_assessments')).toEqual([]);
  });

  it('rejects incompatible schema and unsafe final checks before agent calls', async () => {
    const f = await setup();
    f.host.executeAgent = vi.fn(f.host.executeAgent);
    await f.inspect('CREATE TABLE main.pair_assessments (pair_id VARCHAR)');
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'schema', mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow('rebuild');
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    await f.inspect('DROP TABLE main.pair_assessments');
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

  it('retains failed final-check staging without changing the target', async () => {
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
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'pair_assessments'"
      )
    ).toEqual([]);
    expect(await f.inspect('SELECT validated FROM _bobsled_agentic_publication.stages')).toEqual([
      { validated: false },
    ]);
    const stages = await f.inspect(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'stage_%' AND length(table_name) = 70"
    );
    expect(stages).toHaveLength(1);
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
    expect(
      await f.inspect('SELECT COUNT(*) AS n FROM _bobsled_agentic_publication.receipts')
    ).toEqual([{ n: 1n }]);
    await f.publisher.close();
    const reopened = await createDuckDbAgenticPublisher(f.integration);
    const resumed = await executeAgenticRun(f.host, f.context(), {
      run: { id: 'lost', mode: 'resume' },
      projectDirectory: f.directory,
      publisher: reopened,
    });
    expect(resumed.publication).toBe('confirmed');
    expect(f.host.executeAgent).toHaveBeenCalledTimes(2);
    expect(await f.inspect('SELECT revision FROM _bobsled_agentic_publication.targets')).toEqual([
      { revision: 1n },
    ]);
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
    const other = await createDuckDbAgenticPublisher(f.integration);
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
    expect(await f.inspect('SELECT revision FROM _bobsled_agentic_publication.targets')).toEqual([
      { revision: 1n },
    ]);
    await other.close();
  });

  it('corrects duplicate output inside a fake agent before real SQL publication and reuses it on resume', async () => {
    const f = await setup();
    for (const folder of ['integrations', 'sources', 'models']) {
      await mkdir(join(f.directory, folder));
    }
    const write = (path: string, data: unknown) =>
      writeFile(join(f.directory, path), stringify(data));
    await write('integrations/lake.yml', { ...f.integration, connection: { schema: 'main' } });
    await write('sources/pairs.yml', {
      spec_version: '0.2',
      name: 'pairs',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'lake',
      table: 'main.raw_pairs',
      schema: { columns: [{ name: 'pair_id', type: 'STRING' }] },
    });
    const derived = (name: string, ref: string, columns: string[]) => ({
      spec_version: '0.2',
      type: 'model',
      name,
      description: 'Publication integration',
      grain: 'pair_id',
      source: { ref },
      columns: columns.map((name) => ({ name, expr: name, type: 'STRING' })),
      materialization: { type: 'table' },
    });
    await write('models/prepared.yml', derived('undecided_pairs', 'lake.pairs', ['pair_id']));
    await write('models/agentic.yml', f.model);
    await write(
      'models/advice.yml',
      derived('advice', 'pair_assessments', ['pair_id', 'assessment', '_bobsled_run_id'])
    );
    await f.inspect("CREATE TABLE main.raw_pairs AS SELECT 'p0' AS pair_id");
    f.host.prepare = async () => f.inspect('SELECT pair_id FROM main.undecided_pairs LIMIT 1001');
    f.host.executeAgent = vi.fn(async ({ assignment }) => {
      const schema = createAgentAssignmentOutputSchema(assignment);
      const wire = new Ajv2020({ strict: false, validateFormats: false }).compile(
        JSON.parse(JSON.stringify(schema.toJSONSchema()))
      );
      const row = {
        pair_id: 'p0',
        assessment: 'review',
        _bobsled_evidence: null,
        _bobsled_reason: null,
        _bobsled_confidence: null,
      };
      // Simulate an output tool refusing duplicate rows while the same agent is active.
      expect(wire({ rows: [row, row] })).toBe(false);
      expect(wire.errors?.some((issue) => issue.keyword === 'maxItems')).toBe(true);
      expect(wire({ rows: [row] })).toBe(true);
      return {
        contract_version: 2,
        attempt_id: assignment.attempt_id,
        status: 'succeeded',
        usage: { status: 'unknown', reason: 'unavailable' },
        ...schema.parse({ rows: [row] }),
      };
    });
    const result = await runProject(f.directory, {
      agentic: { run: { id: 'mixed', mode: 'start' }, host: f.host, publisher: f.publisher },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await f.inspect('SELECT * FROM main.advice')).toEqual([
      { pair_id: 'p0', assessment: 'review', _bobsled_run_id: 'mixed' },
    ]);
    const resumed = await runProject(f.directory, {
      agentic: { run: { id: 'mixed', mode: 'resume' }, host: f.host, publisher: f.publisher },
    });
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    expect(f.host.executeAgent).toHaveBeenCalledTimes(1);
    expect(await f.inspect('SELECT COUNT(*) AS n FROM main.pair_assessments')).toEqual([{ n: 1n }]);
  });

  it('binds values and quotes target identifiers without allowing a second fence for an alias', async () => {
    const f = await setup();
    const context = { ...f.context(), target: '"main"."odd""target"' };
    f.host.prepare = async () => [{ pair_id: "key ' ; --" }];
    f.host.executeAgent = async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [
        {
          pair_id: "key ' ; --",
          assessment: 'quoted',
          _bobsled_evidence: null,
          _bobsled_reason: null,
          _bobsled_confidence: null,
        },
      ],
    });
    await executeAgenticRun(f.host, context, {
      run: { id: 'quoted', mode: 'start' },
      projectDirectory: f.directory,
      publisher: f.publisher,
    });
    expect(await f.inspect('SELECT pair_id FROM "main"."odd""target"')).toEqual([
      { pair_id: "key ' ; --" },
    ]);
    await f.publisher.claim('main.pair_assessments');
    await f.publisher.claim('"MAIN"."PAIR_ASSESSMENTS"');
    expect(
      await f.inspect('SELECT COUNT(*) AS n FROM _bobsled_agentic_publication.targets')
    ).toEqual([{ n: 2n }]);
  });

  it('records a committed receipt after cancellation and blocks the cancelled caller', async () => {
    const f = await setup();
    const abort = new AbortController();
    const publisher = {
      ...f.publisher,
      async commit(...args: Parameters<typeof f.publisher.commit>) {
        await f.publisher.commit(...args);
        abort.abort();
        throw abort.signal.reason;
      },
    };
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'cancel', mode: 'start' },
        projectDirectory: f.directory,
        publisher,
        signal: abort.signal,
      })
    ).rejects.toThrow();
    const local = createDefaultAgenticStateStore(f.directory);
    const session = await local.acquire({ scope: 'lake', model: f.model.name, id: 'cancel' });
    expect((await session.read())!.publication).toBe('confirmed');
    await session.release();
    expect(
      (
        await executeAgenticRun(f.host, f.context(), {
          run: { id: 'cancel', mode: 'resume' },
          projectDirectory: f.directory,
          publisher: f.publisher,
        })
      ).publication
    ).toBe('confirmed');
  });
  it.each(['before', 'after'] as const)(
    'recovers a native fault %s target COMMIT',
    async (position) => {
      const f = await setup();
      faults.commit = position;
      const options = {
        run: { id: 'fault', mode: 'start' as const },
        projectDirectory: f.directory,
        publisher: f.publisher,
      };
      if (position === 'before') {
        await expect(executeAgenticRun(f.host, f.context(), options)).rejects.toThrow(
          'before target COMMIT'
        );
        expect(
          await f.inspect(
            "SELECT table_name FROM information_schema.tables WHERE table_name = 'pair_assessments'"
          )
        ).toEqual([]);
        expect(
          await f.inspect('SELECT COUNT(*) AS n FROM _bobsled_agentic_publication.receipts')
        ).toEqual([{ n: 0n }]);
      } else {
        expect((await executeAgenticRun(f.host, f.context(), options)).publication).toBe(
          'confirmed'
        );
      }
      await f.publisher.close();
      const reopened = await createDuckDbAgenticPublisher(f.integration);
      expect(
        (
          await executeAgenticRun(f.host, f.context(), {
            ...options,
            publisher: reopened,
            run: { id: 'fault', mode: 'resume' },
          })
        ).publication
      ).toBe('confirmed');
      expect(await f.inspect('SELECT revision FROM _bobsled_agentic_publication.targets')).toEqual([
        { revision: 1n },
      ]);
      await reopened.close();
    }
  );
  it('enforces every accepted-values rule authored for the same column', async () => {
    const f = await setup();
    f.model.tests = [
      { type: 'accepted_values', column: 'assessment', values: ['allow'] },
      { type: 'accepted_values', column: 'assessment', values: ['deny'] },
    ];
    f.host.executeAgent = async ({ assignment }) => ({
      contract_version: 2,
      attempt_id: assignment.attempt_id,
      status: 'succeeded',
      usage: { status: 'unknown', reason: 'unavailable' },
      rows: [
        {
          pair_id: assignment.group_key.pair_id,
          assessment: 'allow',
          _bobsled_evidence: null,
          _bobsled_confidence: null,
          _bobsled_reason: null,
        },
      ],
    });
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'all-checks', mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow('final check failed');
    expect(
      await f.inspect(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'pair_assessments'"
      )
    ).toEqual([]);
    expect(await f.inspect('SELECT validated FROM _bobsled_agentic_publication.stages')).toEqual([
      { validated: false },
    ]);
  });

  it.each([
    { kind: 'regex' as const, column: 'assessment', pattern: '(?<=foo)bar' },
    { kind: 'in_range' as const, column: 'assessment', min: 1 },
  ])('rejects DuckDB-incompatible $kind checks before agents', async (check) => {
    const f = await setup();
    f.model.expect = [check];
    f.host.executeAgent = vi.fn(f.host.executeAgent);
    await expect(
      executeAgenticRun(f.host, f.context(), {
        run: { id: 'dialect', mode: 'start' },
        projectDirectory: f.directory,
        publisher: f.publisher,
      })
    ).rejects.toThrow();
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    expect(
      await f.inspect('SELECT COUNT(*) AS n FROM _bobsled_agentic_publication.stages')
    ).toEqual([{ n: 0n }]);
  });
});
