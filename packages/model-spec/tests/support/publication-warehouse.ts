import { vi } from 'vitest';
import type { SqlRunnerModule } from '@bobsled-inc/connections';
import {
  publicationNames,
  publicationType,
  type PublicationDialect,
} from '../../src/agentic/sql-publication-dialect.js';
import type { AgenticPublicationContext } from '../../src/agentic/publication.js';
import { runFixture } from '../unit/agentic/state-fixture.js';

type Row = Record<string, unknown>;
const normalize = (sql: string) => sql.replaceAll('"', '').replaceAll('`', '').toLowerCase();

/** A small transactional warehouse double. It keeps row data across runner instances.
 * It exercises publisher decisions and recovery, not vendor SQL syntax acceptance. */
export function publicationWarehouse(
  dialect: PublicationDialect,
  options: { systemSchema?: string; context?: AgenticPublicationContext } = {}
) {
  const { systemSchema } = options;
  const context = options.context ?? runFixture().context();
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
  type Column = AgenticPublicationContext['resolved']['output_columns'][number];
  let reportType = (column: Column) => publicationType(column.type, dialect);
  let targetCollation = (_column: Column): string | null => null;
  let stageCollation = (_column: Column): string | null => null;
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
      // Parameters name the target and optionally a probe table: [schema, table, ...].
      const rows: Row[] = [];
      for (let index = 0; index < params.length; index += 2) {
        const [schema, table] = [String(params[index]), String(params[index + 1])];
        const name = normalize(`${schema}.${table}`);
        const isTarget = name === target;
        if (!tables.has(name) || (isTarget && schemaMismatch)) continue;
        for (const column of context.resolved.output_columns) {
          rows.push({
            table_schema: schema,
            table_name: table,
            column_name: dialect === 'snowflake' ? column.name.toUpperCase() : column.name,
            data_type: isTarget ? reportType(column) : publicationType(column.type, dialect),
            is_nullable: column.nullable ? 'YES' : 'NO',
            collation_name: isTarget ? targetCollation(column) : stageCollation(column),
          });
        }
      }
      return rows;
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
    if (sql === `select count(*) as count from ${target}`) {
      return [{ count: read(target).length }];
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
  return {
    context,
    runner,
    invalidRegex: () => {
      invalidRegex = true;
    },
    schemaMismatch: () => {
      schemaMismatch = true;
    },
    /** Reports another accepted spelling for some existing target columns. */
    reportTypes: (report: typeof reportType) => {
      reportType = report;
    },
    /** Reports collations for existing target columns. */
    reportCollations: (report: typeof targetCollation) => {
      targetCollation = report;
    },
    /** Applies a default collation to columns of stages created later, as a schema can. */
    stageCollations: (report: typeof stageCollation) => {
      stageCollation = report;
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
