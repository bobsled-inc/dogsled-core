import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { AgenticPublicationContext } from '../../src/agentic/publication.js';
import { checkpointTransport } from './checkpoint-transport.js';
import { publicationWarehouse } from './publication-warehouse.js';

const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
type Dialect = 'snowflake' | 'postgres';
/** Reverses literal escaping: doubled quotes, plus backslash sequences except in PostgreSQL. */
const unescape = (text: string, dialect: Dialect) =>
  dialect === 'postgres'
    ? text.replaceAll("''", "'")
    : text.replace(/''|\\(.)/g, (match, next?: string) =>
        match === "''" ? "'" : (escapes[next!] ?? next!)
      );

/** Stateful double for the shared cursor table. One writer; no SQL engine. */
function cursorTable(dialect: Dialect) {
  const rows = new Map<string, { record: string; token: string }>();
  const literal = dialect === 'postgres' ? /'((?:[^']|'')*)'/g : /'((?:[^'\\]|''|\\.)*)'/g;
  const literals = (sql: string) =>
    [...sql.matchAll(literal)].map((match) => unescape(match[1]!, dialect));
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
  // Statements apply immediately: benchmark transactions on this table never roll back.
  const runner: SqlRunnerModule = {
    supportsBindings: true,
    async run(raw: string) {
      let sql = raw;
      if (sql.startsWith('EXECUTE IMMEDIATE ')) sql = unescape(sql.slice(19, -1), dialect);
      if (/^CREATE TABLE/i.test(sql)) {
        if (!rows.has('')) rows.set('', { record: '', token: '' });
      } else if (!/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
        for (const part of sql.split(/;\s*\n/)) {
          const dml = /(?:^|\n)\s*((?:UPDATE|DELETE|INSERT) [\s\S]*)/.exec(part)?.[1];
          if (dml) statement(dml);
        }
      }
      return {};
    },
    async query(sql: string, params: readonly unknown[] = []) {
      if (/^DESCRIBE/i.test(sql)) return [{ tablefeatures: ['catalogManaged'] }];
      if (/SELECT ["`]?token["`]? FROM/i.test(sql)) return [{ token: rows.get('')!.token }];
      if (/SELECT ["`]?record["`]? FROM/i.test(sql)) {
        const row = rows.get(String(params[0]));
        return row ? [{ record: row.record }] : [];
      }
      return [{ valid: 1 }];
    },
  };
  return { runner, rows };
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
 * One in-memory warehouse for a complete agentic run: checkpoint, cursor and publication
 * tables keep state across runner instances. Requests are routed by the tables they name.
 * Snowflake sends each transaction as one script. PostgreSQL sends BEGIN, statements and
 * COMMIT separately on one connection, so each connection forwards BEGIN with its first
 * statement and keeps that target until COMMIT or ROLLBACK. Every request is counted by area
 * and kind and waits `latencyMs`. It models protocol decisions, not provider SQL acceptance
 * or performance.
 */
export function agenticWarehouse(
  context: AgenticPublicationContext,
  dialect: Dialect = 'snowflake'
) {
  // One checkpoint transport per run: each run key has its own control and payload tables.
  const checkpoints = new Map<string, ReturnType<typeof checkpointTransport>>();
  const checkpoint = (sql: string) => {
    const table = /__dogsled_cp_([a-f0-9]{48})_/i.exec(sql)![1]!.toLowerCase();
    if (!checkpoints.has(table)) checkpoints.set(table, checkpointTransport(0, false));
    return checkpoints.get(table)!.runner;
  };
  const cursors = cursorTable(dialect);
  const publication = publicationWarehouse(dialect, { context });
  const schemas: SqlRunnerModule = { supportsBindings: true, run: async () => ({}) };
  const operations: Record<string, number> = {};
  const faults: { pattern: RegExp; skip: number; after: boolean }[] = [];
  let runners = 0;
  let latencyMs = 0;
  const count = async (name: string) => {
    operations[name] = (operations[name] ?? 0) + 1;
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  };
  const target = (area: string, sql: string): SqlRunnerModule =>
    area === 'schema'
      ? schemas
      : area === 'checkpoint'
        ? checkpoint(sql)
        : area === 'cursor'
          ? cursors.runner
          : publication.runner;
  /** A connection: one SQL session with its own transaction state. */
  const connection = (): SqlRunnerModule => {
    let begin = false;
    let open: { area: string; runner: SqlRunnerModule; lost: boolean } | undefined;
    const route = async (sql: string) => {
      const name = category(sql);
      const area = open?.area ?? name.split(':')[0]!;
      await count(`${area}:${name.split(':')[1]}`);
      const fault = faults.find((item) => !item.after && item.pattern.test(sql));
      if (fault && fault.skip-- === 0) {
        faults.splice(faults.indexOf(fault), 1);
        throw new Error('Synthetic warehouse request failure');
      }
      const runner = open?.runner ?? target(area, sql);
      if (begin) {
        // BEGIN names no table. Forward it to the first statement's area.
        begin = false;
        open = { area, runner, lost: false };
        operations[`${area}:transaction`] = (operations[`${area}:transaction`] ?? 0) + 1;
        await runner.run('BEGIN');
      }
      return runner;
    };
    /** Applies a request, then loses its response when an armed fault matches. Inside an
     * open transaction the COMMIT response is lost instead, after it applies. */
    const deliver = <T>(sql: string, result: T): T => {
      const fault = faults.find((item) => item.after && item.pattern.test(sql));
      if (fault) {
        faults.splice(faults.indexOf(fault), 1);
        if (open) open.lost = true;
        else throw new Error('Synthetic lost response');
      }
      return result;
    };
    return {
      supportsBindings: true,
      async run(sql) {
        if (sql === 'BEGIN') {
          // Counted when its area is known; the round trip happens now.
          if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
          begin = true;
          return {};
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          const current = open;
          open = undefined;
          begin = false;
          await count(`${current?.area ?? 'publication'}:transaction`);
          // A ROLLBACK after a COMMIT is a no-op, as on PostgreSQL.
          const result = current ? await current.runner.run(sql) : {};
          if (sql === 'COMMIT' && current?.lost) throw new Error('Synthetic lost response');
          return result;
        }
        const runner = await route(sql);
        return deliver(sql, await runner.run(sql));
      },
      async query(sql, params) {
        const runner = await route(sql);
        return deliver(sql, await runner.query!(sql, params));
      },
      async close() {},
    };
  };
  return {
    /** Opens a connection; each is a separate login on a real warehouse. */
    acquire() {
      runners++;
      return connection();
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
