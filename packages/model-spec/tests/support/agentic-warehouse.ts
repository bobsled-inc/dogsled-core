import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { AgenticPublicationContext } from '../../src/agentic/publication.js';
import { checkpointTransport } from './checkpoint-transport.js';
import { publicationWarehouse } from './publication-warehouse.js';

const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
/** Reverses Snowflake literal escaping: doubled quotes and backslash sequences. */
const unescape = (text: string) =>
  text.replace(/''|\\(.)/g, (match, next?: string) =>
    match === "''" ? "'" : (escapes[next!] ?? next!)
  );

/** Stateful double for the shared cursor table. One writer; no SQL engine. */
function cursorTable() {
  const rows = new Map<string, { record: string; token: string }>();
  const literals = (sql: string) =>
    [...sql.matchAll(/'((?:[^'\\]|''|\\.)*)'/g)].map((match) => unescape(match[1]!));
  const statement = (sql: string) => {
    const insert = /INSERT INTO [^(]+\([^)]*\) VALUES \((.*)\)\s*$/is.exec(sql)?.[1];
    if (insert) {
      const [key, record, token] = literals(insert);
      rows.set(key!, { record: record!, token: token! });
    } else if (/^\s*DELETE FROM/i.test(sql)) {
      const [key] = literals(sql.slice(sql.search(/WHERE/i)));
      rows.delete(key!);
    } else if (/^\s*UPDATE/i.test(sql)) {
      const [token] = literals(sql);
      rows.get('')!.token = token!;
    }
  };
  return {
    run(raw: string) {
      let sql = raw;
      if (sql.startsWith('EXECUTE IMMEDIATE ')) sql = unescape(sql.slice(19, -1));
      if (/^CREATE TABLE/i.test(sql)) {
        if (!rows.has('')) rows.set('', { record: '', token: '' });
      } else if (!/^(CREATE SCHEMA|BEGIN|COMMIT|ROLLBACK)$/i.test(sql.split(' ')[0]!)) {
        for (const part of sql.split(/;\s*\n/)) {
          const dml = /(?:^|\n)\s*((?:UPDATE|DELETE|INSERT) [\s\S]*)/.exec(part)?.[1];
          if (dml) statement(dml);
        }
      }
      return {};
    },
    query(sql: string, params: readonly unknown[] = []) {
      if (/^DESCRIBE/i.test(sql)) return [{ tablefeatures: ['catalogManaged'] }];
      if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: rows.get('')!.token }];
      if (/SELECT ["`]?record["`]? FROM/i.test(sql)) {
        const row = rows.get(String(params[0]));
        return row ? [{ record: row.record }] : [];
      }
      return [{ valid: 1 }];
    },
    rows,
  };
}

function category(sql: string): string {
  const text = sql.replaceAll('"', '').replaceAll('`', '').toLowerCase();
  // Every store creates its schema; those requests are counted separately.
  const area = /^create schema/.test(text)
    ? 'schema'
    : /__dogsled_cp_/.test(text)
      ? 'checkpoint'
      : /__dogsled_cursors/.test(text)
        ? 'cursor'
        : 'publication';
  const kind = /^(create|drop) /.test(text)
    ? 'ddl'
    : /information_schema|^describe/.test(text)
      ? 'introspection'
      : /^(begin|commit|rollback)$|^execute immediate|^begin (transaction|atomic)|^declare /.test(
            text
          )
        ? 'transaction'
        : /^select violation_count/.test(text)
          ? 'checks'
          : /^insert into \S+ (\([^)]*\) )?select .* where not exists/.test(text)
            ? 'copy'
            : /^insert /.test(text)
              ? 'insert'
              : /^select count\(\*\)|sum\(length/.test(text)
                ? 'count'
                : /^update /.test(text)
                  ? 'update'
                  : /^delete /.test(text)
                    ? 'delete'
                    : 'select';
  return `${area}:${kind}`;
}

/**
 * One in-memory Snowflake-dialect warehouse for a complete agentic run: checkpoint, cursor
 * and publication tables keep state across runner instances. Each transaction is one script
 * request, routed by the tables it names. Every request is counted by area and kind and waits
 * `latencyMs`. It models protocol decisions, not provider SQL acceptance or performance.
 */
export function agenticWarehouse(context: AgenticPublicationContext) {
  // One checkpoint transport per run: each run key has its own control and payload tables.
  const checkpoints = new Map<string, ReturnType<typeof checkpointTransport>>();
  const checkpoint = (sql: string) => {
    const table = /__dogsled_cp_([a-f0-9]{48})_/i.exec(sql)![1]!.toLowerCase();
    if (!checkpoints.has(table)) checkpoints.set(table, checkpointTransport(0, false));
    return checkpoints.get(table)!.runner;
  };
  const cursors = cursorTable();
  const publication = publicationWarehouse('snowflake', { context });
  const operations: Record<string, number> = {};
  const faults: { pattern: RegExp; skip: number; after: boolean }[] = [];
  let runners = 0;
  let latencyMs = 0;
  const route = async (sql: string) => {
    const name = category(sql);
    operations[name] = (operations[name] ?? 0) + 1;
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const fault = faults.find((item) => !item.after && item.pattern.test(sql));
    if (fault && fault.skip-- === 0) {
      faults.splice(faults.indexOf(fault), 1);
      throw new Error('Synthetic warehouse request failure');
    }
    return name.split(':')[0];
  };
  /** Applies a request, then loses its response when an armed fault matches. */
  const deliver = async <T>(sql: string, result: T): Promise<T> => {
    const fault = faults.find((item) => item.after && item.pattern.test(sql));
    if (fault) {
      faults.splice(faults.indexOf(fault), 1);
      throw new Error('Synthetic lost response');
    }
    return result;
  };
  const runner: SqlRunnerModule = {
    supportsBindings: true,
    async run(sql) {
      const area = await route(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) throw new Error('Expected one-request scripts');
      if (area === 'schema') return {};
      if (area === 'checkpoint') return deliver(sql, await checkpoint(sql).run(sql));
      if (area === 'cursor') return deliver(sql, cursors.run(sql));
      return deliver(sql, await publication.runner.run(sql));
    },
    async query(sql, params) {
      const area = await route(sql);
      if (area === 'checkpoint') return checkpoint(sql).query!(sql, params);
      if (area === 'cursor') return cursors.query(sql, params);
      return publication.runner.query!(sql, params);
    },
    async close() {},
  };
  return {
    /** Counts runner acquisitions, each a separate connection on a real warehouse. */
    acquire() {
      runners++;
      return runner;
    },
    get runners() {
      return runners;
    },
    /** Starts a measured phase with the given simulated request latency. */
    measure(latency: number) {
      latencyMs = latency;
      runners = 0;
      for (const name of Object.keys(operations)) delete operations[name];
    },
    /** Fails the matching request after `skip` successful matches. */
    fail(pattern: RegExp, skip = 0) {
      faults.push({ pattern, skip, after: false });
    },
    /** Applies the next matching statement, then loses its response. */
    loseResponse(pattern: RegExp) {
      faults.push({ pattern, skip: 0, after: true });
    },
    operations,
    checkpoints,
    cursors,
    publication,
  };
}
