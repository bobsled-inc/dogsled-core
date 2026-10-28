import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationFile, SqlRunnerModule } from '@bobsled-inc/connections';
import type { JsonValue } from '@bobsled-inc/protocol';
import { createSqlAgenticPublisher } from '../../../src/agentic/sql-publisher.js';
import { AgenticPublicationIdentitySchema } from '../../../src/agentic/publication.js';
import {
  publicationNames,
  publicationTransactionSql,
  publicationType,
  type PublicationDialect,
} from '../../../src/agentic/sql-publication-dialect.js';
import { digestAgenticState } from '../../../src/agentic/state.js';
import { runFixture, MemoryStateStore } from './state-fixture.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@bobsled-inc/connections', async (original) => ({
  ...(await original<typeof import('@bobsled-inc/connections')>()),
  resolveRunner: resolve,
}));
beforeEach(() => resolve.mockReset());
it('assigns Snowflake ownership checks with scalar subqueries', () => {
  const assertion =
    "(SELECT COUNT(*) FROM control) = 1 AND (SELECT COUNT(*) FROM control WHERE token = 'current') = 1";
  const sql = publicationTransactionSql(
    'snowflake',
    ["UPDATE control SET owner = 'next'"],
    assertion
  );
  expect(sql).toContain(`matches := (SELECT CASE WHEN (${assertion}) THEN 1 ELSE 0 END);`);
  expect(sql).not.toContain('INTO :matches');
  expect(sql).toContain('IF (matches <> 1) THEN RAISE stale; END IF;');
  expect(sql).toContain('EXCEPTION WHEN OTHER THEN ROLLBACK; RAISE;');
});

it('rejects ClickHouse before opening a runner', async () => {
  await expect(
    createSqlAgenticPublisher({
      spec_version: '1',
      type: 'integration',
      name: 'local',
      source_type: 'clickhouse',
      connection: { host: 'localhost', database: 'default' },
      auth: { type: 'password', user: 'default', password: 'test' },
    })
  ).rejects.toThrow('Agentic publication does not support ClickHouse');
  expect(resolve).not.toHaveBeenCalled();
});

type Row = Record<string, unknown>;
const normalize = (sql: string) => sql.replaceAll('"', '').replaceAll('`', '').toLowerCase();
const configs: Record<PublicationDialect, IntegrationFile> = {
  postgres: {
    spec_version: '1',
    type: 'integration',
    name: 'test',
    source_type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'test' },
    auth: { type: 'password', user: 'test', password: 'test' },
  },
  snowflake: {
    spec_version: '1',
    type: 'integration',
    name: 'test',
    source_type: 'snowflake',
    connection: { account_identifier: 'test', warehouse: 'test', role: 'test', user: 'test' },
    auth: { type: 'pat', token: 'test' },
  },
  bigquery: {
    spec_version: '1',
    type: 'integration',
    name: 'test',
    source_type: 'bigquery',
    connection: { project_id: 'test' },
    auth: { type: 'adc' },
  },
  databricks: {
    spec_version: '1',
    type: 'integration',
    name: 'test',
    source_type: 'databricks',
    connection: {
      workspace_url: 'https://test.cloud.databricks.com',
      http_path: '/sql/test',
      catalog: 'test',
      schema: 'main',
    },
    auth: { type: 'pat', token: 'test' },
  },
};

/** A small transactional warehouse double. It keeps row data across runner instances.
 * It exercises publisher decisions and recovery, not vendor SQL syntax acceptance. */
function database(dialect: PublicationDialect, systemSchema?: string) {
  const context = runFixture().context();
  const names = publicationNames(context.target, dialect, systemSchema);
  const target = normalize(names.target),
    control = normalize(names.control),
    manifests = normalize(names.manifests),
    receipts = normalize(names.receipts);
  let tables = new Map<string, Row[]>();
  let snapshot: Map<string, Row[]> | undefined;
  const columns = new Map<string, string[]>();
  const events: string[] = [];
  let failChecks = false,
    loseResponse = false,
    invalidRegex = false,
    schemaMismatch = false,
    catalogEnabled = true;
  const row = (pair_id: string, assessment = 'old'): Row => ({
    pair_id,
    assessment,
    _dogsled_run_id: 'saved',
    _dogsled_evidence: null,
    _dogsled_confidence: null,
    _dogsled_reason: null,
  });
  tables.set(target, [row('a'), row('b'), row('c')]);
  const read = (name: string) => tables.get(name) ?? [];
  const controlRow = () => read(control)[0]!;
  function predicate(sql: string): boolean {
    const revision = /where revision = (\d+)/.exec(sql)?.[1];
    const fence = /fence = '([^']+)'/.exec(sql)?.[1];
    const token = /commit_token = '([^']+)'/.exec(sql)?.[1];
    return (
      read(control).length === 1 &&
      (revision === undefined || controlRow().revision === Number(revision)) &&
      (fence === undefined || controlRow().fence === fence) &&
      (token === undefined || controlRow().commit_token === token)
    );
  }
  function apply(raw: string) {
    const sql = normalize(raw).trim();
    events.push(sql);
    const created = /^create table (?:if not exists )?([^\s(]+)/.exec(sql)?.[1];
    if (created) {
      if (!tables.has(created)) {
        tables.set(
          created,
          created === control ? [{ revision: 0, fence: '', commit_token: '' }] : []
        );
      }
      const shape = /^create table (?:if not exists )?[^\s(]+ \((.*)\)/.exec(sql)?.[1];
      if (shape) {
        columns.set(
          created,
          shape.split(', ').map((part) => part.split(' ')[0]!)
        );
      }
      return;
    }
    const dropped = /^drop table (?:if exists )?([^\s;]+)/.exec(sql)?.[1];
    if (dropped) {
      tables.delete(dropped);
      return;
    }
    if (sql.startsWith(`update ${control} set revision = revision + 1`)) {
      if (predicate(sql.slice(sql.indexOf('where')))) {
        controlRow().revision = Number(controlRow().revision) + 1;
        const token = /commit_token = '([^']+)'/.exec(sql)?.[1];
        if (token) controlRow().commit_token = token;
      }
      return;
    }
    const deleted = /^delete from ([^\s;]+)/.exec(sql)?.[1];
    if (deleted) {
      if (!sql.includes('where 1 = 0')) tables.set(deleted, []);
      return;
    }
    const inserted = /^insert into ([^\s(]+)/.exec(sql)?.[1];
    if (inserted) {
      if (inserted === receipts) {
        const op = /operation_id = '([^']+)'/.exec(sql)![1];
        read(receipts).push(
          ...read(manifests)
            .filter((entry) => entry.operation_id === op)
            .map((entry) => ({ operation_id: op, receipt: entry.receipt }))
        );
      } else if (sql.includes('where not exists')) {
        const processed = /select 1 from ([^\s]+)/.exec(sql)![1];
        const keys = new Set(read(processed).map((entry) => entry.pair_id));
        read(inserted).push(
          ...structuredClone(read(target).filter((entry) => !keys.has(entry.pair_id)))
        );
      } else {
        const source = / from ([^\s;]+)$/.exec(sql)![1];
        read(inserted).push(...structuredClone(read(source)));
      }
    }
  }
  async function run(raw: string) {
    let sql = raw;
    if (sql.startsWith('EXECUTE IMMEDIATE ')) {
      sql = sql.slice(19, -1).replaceAll("''", "'").replaceAll("\\'", "'").replaceAll('\\n', '\n');
    }
    if (/^(BEGIN TRANSACTION;|BEGIN ATOMIC|DECLARE stale)/.test(sql)) {
      const before = structuredClone(tables);
      try {
        for (const statement of sql.split(';').map((part) => part.trim())) {
          const dml = /(?:^|\n)((?:UPDATE|DELETE|INSERT) [\s\S]*)/.exec(statement)?.[1];
          if (dml) apply(dml);
        }
        if (!predicate(normalize(sql.slice(sql.indexOf('SELECT COUNT(*)'))))) {
          throw new Error('Stale publication owner or target version');
        }
      } catch (error) {
        tables = before;
        throw error;
      }
      if (loseResponse && read(receipts).length) {
        loseResponse = false;
        throw new Error('response lost after commit');
      }
      return { rowCount: 0 };
    }
    if (sql === 'BEGIN') snapshot = structuredClone(tables);
    else if (sql === 'ROLLBACK') {
      if (snapshot) tables = snapshot;
      snapshot = undefined;
    } else if (sql === 'COMMIT') {
      snapshot = undefined;
      if (loseResponse && read(receipts).length) {
        loseResponse = false;
        throw new Error('response lost after commit');
      }
    } else apply(sql);
    return { rowCount: 0 };
  }
  const query: NonNullable<SqlRunnerModule['query']> = async (raw, args) => {
    const sql = normalize(raw),
      params = Array.isArray(args) ? args : [];
    if (sql.includes('information_schema.tables')) {
      return tables.has(target) ? [{ table_type: 'BASE TABLE' }] : [];
    }
    if (sql.includes('information_schema.columns')) {
      if (schemaMismatch) return [];
      return context.resolved.output_columns.map((column) => ({
        column_name: dialect === 'snowflake' ? column.name.toUpperCase() : column.name,
        data_type: publicationType(column.type, dialect),
        is_nullable: column.nullable ? 'YES' : 'NO',
      }));
    }
    if (sql.startsWith('describe detail')) {
      return [{ tableFeatures: catalogEnabled ? ['catalogManaged'] : [] }];
    }
    if (sql.startsWith('select violation_count')) return [{ violation_count: failChecks ? 1 : 0 }];
    if (sql.endsWith('as matched')) {
      if (invalidRegex) throw new Error('warehouse regex syntax error');
      return [{ matched: 0 }];
    }
    if (sql.startsWith('select case when')) return [{ valid: predicate(sql) ? 1 : 0 }];
    if (sql.startsWith(`update ${control} set fence`)) {
      controlRow().fence = params[0];
      return [];
    }
    if (sql.startsWith(`select revision, fence from ${control}`)) {
      return structuredClone(read(control));
    }
    if (sql.startsWith(`select revision from ${control}`)) {
      return controlRow().fence === params[0] && controlRow().revision === params[1]
        ? [{ revision: params[1] }]
        : [];
    }
    if (sql.startsWith(`select receipt from ${receipts}`)) {
      return read(receipts).filter((entry) => entry.operation_id === params[0]);
    }
    if (sql.includes(` from ${manifests}`)) {
      return sql.startsWith('select count')
        ? [{ count: read(manifests).length }]
        : read(manifests).filter((entry) => entry.operation_id === params[0]);
    }
    if (sql.startsWith('select count(*) as count from (')) {
      const processed = /select 1 from ([^\s]+)/.exec(sql)![1];
      const keys = new Set(read(processed).map((entry) => entry.pair_id));
      return [{ count: read(target).filter((entry) => !keys.has(entry.pair_id)).length }];
    }
    const inserted = /^insert into ([^\s(]+)/.exec(sql)?.[1];
    if (inserted) {
      if (inserted === manifests) {
        const shape = columns.get(manifests)!;
        read(manifests).push(
          Object.fromEntries(shape.map((name, index) => [name, params[index] ?? false]))
        );
      } else {
        const shape = /^insert into [^\s(]+ \(([^)]+)\)/.exec(sql)![1].split(', ');
        let position = 0;
        for (const select of sql.slice(sql.indexOf('select ')).split(' union all ')) {
          const expressions = select.slice(7).split(', ');
          read(inserted).push(
            Object.fromEntries(
              shape.map((name, index) => [
                name,
                expressions[index]!.includes('null') ? null : params[position++],
              ])
            )
          );
        }
      }
      return [];
    }
    if (sql.startsWith(`update ${manifests} set validated`)) {
      read(manifests).find((entry) => entry.operation_id === params[0])!.validated = true;
      return [];
    }
    throw new Error(`Unexpected mock query: ${raw}`);
  };
  const close = vi.fn(async () => {});
  const runner = { run: vi.fn(run), query: vi.fn(query), close, supportsBindings: true };
  resolve.mockImplementation(async () => runner);
  return {
    context,
    runner,
    invalidRegex: () => {
      invalidRegex = true;
    },
    schemaMismatch: () => {
      schemaMismatch = true;
    },
    disableCatalog: () => {
      catalogEnabled = false;
    },
    manifests: () => read(manifests),
    names,
    row,
    events,
    close,
    target: () => structuredClone(read(target)),
    receipts: () => read(receipts),
    failChecks: () => {
      failChecks = true;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    stale: () => {
      controlRow().fence = 'new-owner';
    },
    absent: () => {
      tables.delete(target);
    },
    exists: () => tables.has(target),
  };
}

for (const dialect of Object.keys(configs) as PublicationDialect[]) {
  it(`${dialect} keeps generated publication names within 63 ASCII bytes`, () => {
    const target = dialect === 'postgres' ? 'public.result' : 'catalog.public.result';
    const names = publicationNames(target, dialect);
    const leaf = (reference: string) => reference.match(/["`]([^"`]+)["`]$/)![1]!;
    const prefix = dialect === 'snowflake' ? '_DOGSLED_PUB_' : '_dogsled_pub_';
    for (const suffix of ['', '_c', '_p']) {
      const name = leaf(names.stage('f'.repeat(128), suffix));
      expect(name.startsWith(prefix)).toBe(true);
      expect(Buffer.byteLength(name, 'utf8')).toBe(61 + suffix.length);
      expect(name).toMatch(/^[a-z0-9_]+$/i);
      expect(name).toBe(dialect === 'snowflake' ? name.toUpperCase() : name.toLowerCase());
    }
    for (const reference of [names.control, names.manifests, names.receipts]) {
      expect(Buffer.byteLength(leaf(reference), 'utf8')).toBeLessThanOrEqual(63);
    }
    expect(() => publicationNames(target.replace('result', prefix + 'reserved'), dialect)).toThrow(
      'reserved'
    );
  });

  describe(`${dialect} publication protocol with a transactional runner`, () => {
    async function prepared(
      rows?: JsonValue[],
      keys: JsonValue[] = [{ pair_id: 'a' }, { pair_id: 'b' }],
      systemSchema?: string
    ) {
      const db = database(dialect, systemSchema);
      const publisher = await createSqlAgenticPublisher(configs[dialect], { systemSchema });
      await publisher.preflight(db.context);
      const claim = await publisher.claim(db.context.target);
      const accepted = rows ?? [db.row('a', 'new') as JsonValue];
      const identity = AgenticPublicationIdentitySchema.parse({
        operation_id: 'a'.repeat(64),
        run: { scope: 'test', model: 'test', id: 'run' },
        definition_digest: 'b'.repeat(64),
        target: db.context.target,
        schema_digest: digestAgenticState(db.context.resolved.output_columns),
        results_digest: digestAgenticState(accepted),
        processed_keys_digest: digestAgenticState(keys),
      });
      return { db, publisher, claim, identity, accepted, keys };
    }
    it('keeps publication tables in the configured system schema', async () => {
      const f = await prepared(undefined, undefined, 'system_store');
      const intent = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      const receipt = await f.publisher.commit(intent, f.claim);
      const restarted = await createSqlAgenticPublisher(configs[dialect], {
        systemSchema: 'system_store',
      });
      expect(await restarted.inspect(intent)).toEqual(receipt);
      expect(f.db.target().map((row) => [row.pair_id, row.assessment])).toEqual([
        ['c', 'old'],
        ['a', 'new'],
      ]);
      const internalCreates = f.db.events.filter(
        (sql) => sql.startsWith('create table') && sql.includes('_dogsled_pub_')
      );
      expect(internalCreates.length).toBeGreaterThan(3);
      expect(internalCreates.every((sql) => sql.includes('system_store._dogsled_pub_'))).toBe(true);
    });
    it('replaces processed keys, removes zero-result B, and keeps unprocessed C', async () => {
      const f = await prepared();
      const intent = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      expect(f.db.target().map((row) => row.assessment)).toEqual(['old', 'old', 'old']);
      const receipt = await f.publisher.commit(intent, f.claim);
      expect(f.db.target().map((row) => [row.pair_id, row.assessment])).toEqual([
        ['c', 'old'],
        ['a', 'new'],
      ]);
      expect(await f.publisher.inspect(intent)).toEqual(receipt);
      expect(f.db.close).toHaveBeenCalled();
    });
    it('removes every old result for keys that produced no accepted rows', async () => {
      const f = await prepared([]);
      const intent = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      await f.publisher.commit(intent, f.claim);
      expect(f.db.target().map((row) => row.pair_id)).toEqual(['c']);
    });
    it('does not create an absent target for an empty-input no-op', async () => {
      const f = await prepared([], []);
      f.db.absent();
      const intent = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      await f.publisher.commit(intent, f.claim);
      expect(f.db.exists()).toBe(false);
      expect(f.db.receipts()).toHaveLength(1);
    });
    it('refuses stale preparation before deleting or building staging tables', async () => {
      const f = await prepared();
      f.db.stale();
      const start = f.db.events.length;
      await expect(
        f.publisher.prepare(f.db.context, f.identity, f.accepted, f.keys, f.claim)
      ).rejects.toThrow('Stale');
      expect(f.db.events.slice(start)).toEqual([]);
      expect(f.db.target().map((row) => row.pair_id)).toEqual(['a', 'b', 'c']);
    });
    it('rejects a second prepared intent that reuses the same stale claim', async () => {
      const f = await prepared();
      const first = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      const second = await f.publisher.prepare(
        f.db.context,
        { ...f.identity, operation_id: 'd'.repeat(64) },
        f.accepted,
        f.keys,
        f.claim
      );
      await f.publisher.commit(first, f.claim);
      const committed = f.db.target();
      await expect(f.publisher.commit(second, f.claim)).rejects.toThrow('Stale');
      expect(f.db.target()).toEqual(committed);
      expect(f.db.receipts()).toHaveLength(1);
    });
    it('fails a warehouse regex probe before calling the agent', async () => {
      const db = database(dialect);
      db.invalidRegex();
      db.context.resolved.model.expect.push({
        kind: 'regex',
        column: 'assessment',
        pattern: '(?<=foo)bar',
      });
      const publisher = await createSqlAgenticPublisher(configs[dialect]);
      const host = runFixture().host;
      host.executeAgent = vi.fn(host.executeAgent);
      await expect(
        executeAgenticRun(host, db.context, {
          publisher,
          run: { id: 'bad-regex', mode: 'start' },
          stateStore: new MemoryStateStore(),
          projectDirectory: '/unused',
        })
      ).rejects.toThrow('warehouse regex syntax error');
      expect(host.executeAgent).not.toHaveBeenCalled();
      expect(db.target().map((row) => row.pair_id)).toEqual(['a', 'b', 'c']);
    });
    it('counts an incomplete manifest toward the retention limit', async () => {
      const f = await prepared();
      const bounded = await createSqlAgenticPublisher(configs[dialect], { maxRetainedStages: 1 });
      f.db.failChecks();
      await expect(
        bounded.prepare(f.db.context, f.identity, f.accepted, f.keys, f.claim)
      ).rejects.toThrow('final check');
      expect(f.db.manifests()).toHaveLength(1);
      expect(f.db.manifests()[0]!.validated).toBe(false);
      const before = f.db.events.length;
      await expect(
        bounded.prepare(
          f.db.context,
          { ...f.identity, operation_id: 'e'.repeat(64) },
          f.accepted,
          f.keys,
          f.claim
        )
      ).rejects.toThrow('retention limit');
      expect(f.db.events.slice(before)).toEqual([]);
    });
    it('rejects an existing target with the wrong schema', async () => {
      const db = database(dialect);
      db.schemaMismatch();
      const publisher = await createSqlAgenticPublisher(configs[dialect]);
      await expect(publisher.preflight(db.context)).rejects.toThrow('schema differs');
      expect(db.target().map((row) => row.pair_id)).toEqual(['a', 'b', 'c']);
      expect(db.close).toHaveBeenCalledOnce();
    });
    it('checks row bounds before creating an oversized replacement', async () => {
      const f = await prepared();
      const bounded = await createSqlAgenticPublisher(configs[dialect], { maxStageRows: 1 });
      await expect(
        bounded.prepare(f.db.context, f.identity, f.accepted, f.keys, f.claim)
      ).rejects.toThrow('stage row limit');
      expect(f.db.target().map((row) => row.pair_id)).toEqual(['a', 'b', 'c']);
    });
    it('rejects invalid limits and refuses to open a closed publisher', async () => {
      const db = database(dialect);
      await expect(
        createSqlAgenticPublisher(configs[dialect], { maxRetainedStages: 0 })
      ).rejects.toThrow('retention limits');
      expect(resolve).not.toHaveBeenCalled();
      const publisher = await createSqlAgenticPublisher(configs[dialect]);
      await publisher.close();
      await expect(publisher.preflight(db.context)).rejects.toThrow('closed');
      expect(resolve).not.toHaveBeenCalled();
    });
    it('forwards cancellation and does not open a runner after an abort', async () => {
      const db = database(dialect);
      const publisher = await createSqlAgenticPublisher(configs[dialect]);
      const controller = new AbortController();
      await publisher.preflight(db.context, controller.signal);
      expect(db.runner.run).toHaveBeenCalledWith(expect.stringContaining('CREATE SCHEMA'), {
        signal: controller.signal,
      });
      expect(db.runner.query).toHaveBeenCalledWith(
        expect.stringContaining('TABLES'),
        expect.any(Array),
        { signal: controller.signal }
      );
      resolve.mockClear();
      controller.abort();
      await expect(publisher.claim(db.context.target, controller.signal)).rejects.toThrow();
      expect(resolve).not.toHaveBeenCalled();
    });
    if (dialect === 'databricks') {
      it('rejects warehouses without catalog commits', async () => {
        const db = database(dialect);
        db.disableCatalog();
        const publisher = await createSqlAgenticPublisher(configs[dialect]);
        await expect(publisher.preflight(db.context)).rejects.toThrow('catalog commits');
        expect(db.target().map((row) => row.pair_id)).toEqual(['a', 'b', 'c']);
      });
    }
    it('retains the target when final checks fail', async () => {
      const f = await prepared();
      f.db.failChecks();
      await expect(
        f.publisher.prepare(f.db.context, f.identity, f.accepted, f.keys, f.claim)
      ).rejects.toThrow('final check');
      expect(f.db.target().map((row) => row.pair_id)).toEqual(['a', 'b', 'c']);
      expect(f.db.receipts()).toHaveLength(0);
    });
    it('records an empty-input no-op without removing existing rows', async () => {
      const f = await prepared([], []);
      const intent = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      await f.publisher.commit(intent, f.claim);
      expect(f.db.target().map((row) => row.pair_id)).toEqual(['a', 'b', 'c']);
      expect(f.db.receipts()).toHaveLength(1);
    });
    it('rolls back stale ownership without changing target rows or saving a receipt', async () => {
      const f = await prepared();
      const intent = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      f.db.stale();
      await expect(f.publisher.commit(intent, f.claim)).rejects.toThrow('Stale');
      expect(f.db.target().map((row) => row.pair_id)).toEqual(['a', 'b', 'c']);
      expect(f.db.receipts()).toHaveLength(0);
    });
    it('finds a committed receipt after a lost response and a new publisher instance', async () => {
      const f = await prepared();
      const intent = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      f.db.loseResponse();
      await expect(f.publisher.commit(intent, f.claim)).rejects.toThrow('response lost');
      const restarted = await createSqlAgenticPublisher(configs[dialect]);
      expect(await restarted.inspect(intent)).toEqual({ intent, committed_version: 1 });
      await restarted.commit(intent, f.claim);
      expect(f.db.receipts()).toHaveLength(1);
    });
    it('rejects a receipt for a different immutable intent', async () => {
      const f = await prepared();
      const intent = await f.publisher.prepare(
        f.db.context,
        f.identity,
        f.accepted,
        f.keys,
        f.claim
      );
      await f.publisher.commit(intent, f.claim);
      await expect(
        f.publisher.inspect({
          ...intent,
          identity: { ...intent.identity, definition_digest: 'c'.repeat(64) },
        })
      ).rejects.toThrow('identity conflict');
    });
  });
}

for (const dialect of Object.keys(configs) as PublicationDialect[]) {
  it(`${dialect} quotes the system schema without changing the target address`, () => {
    const target = dialect === 'postgres' ? 'public.result' : 'catalog.public.result';
    const original = publicationNames(target, dialect);
    const names = publicationNames(target, dialect, 'internal.store');
    expect(names.target).toBe(original.target);
    expect(names.namespace).toBe(original.namespace);
    expect(names.schema).toBe(original.schema);
    expect(names.catalog).toBe(original.catalog);
    expect(names.storageNamespace).toContain(
      dialect === 'bigquery' || dialect === 'databricks'
        ? '`internal.store`'
        : dialect === 'snowflake'
          ? '"INTERNAL.STORE"'
          : '"internal.store"'
    );
    expect(() => publicationNames(target, dialect, ' ')).toThrow(
      'Invalid publication system schema'
    );
  });
}
