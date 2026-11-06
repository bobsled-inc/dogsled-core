/**
 * A stand-in for Snowflake that runs the row store's SQL on an in-memory DuckDB. It keeps what
 * the store depends on and Snowflake documents: no enforced keys, `?` binds, DML results as a
 * row of counts, numbers read back as text, statements of at most 1 MB with their bound values,
 * `UPDATE` and `DELETE` taking a table lock that lasts until commit while `INSERT` takes none, and
 * each statement seeing only what committed before it began. It refuses SQL that Snowflake would
 * reject and that DuckDB accepts.
 *
 * This proves a dialect's logic in every test run. It does not prove Snowflake behaves as
 * documented: only `tests/integration/warehouse/cloud-row-store.test.ts` does that.
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildDuckDbRunner,
  CustomRunnerRegistry,
  type DuckDbIntegration,
  type RunnerFactoryContext,
  type SnowflakeIntegration,
  type SqlParams,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';

type Row = Record<string, unknown>;

const CLOCK = 'DATE_PART(EPOCH_MILLISECOND, SYSDATE())';
const engineClock = 'CAST(epoch(now()) * 1000 AS BIGINT)';
/** Long enough for concurrent statements to overlap, so a missing lock shows as a race. */
const statementGapMs = 5;
const waiterLimit = 20;
const statementLimitBytes = 1_000_000;

const integration = {
  spec_version: '1',
  type: 'integration',
  name: 'lake',
  source_type: 'snowflake',
  connection: {
    account_identifier: 'emulator',
    warehouse: 'compute',
    role: 'tester',
    user: 'tester',
    database: 'memory',
  },
  auth: { type: 'pat', token: 'emulator' },
} satisfies SnowflakeIntegration;

const memory: DuckDbIntegration = {
  spec_version: '1',
  type: 'integration',
  name: 'engine',
  source_type: 'duckdb',
  connection: {},
  auth: { type: 'memory' },
};

/** Decodes every Snowflake string literal in `sql` and hands it to `rewrite`. */
function mapLiterals(sql: string, rewrite: (text: string) => string): string {
  let out = '';
  for (let index = 0; index < sql.length; ) {
    const char = sql[index]!;
    if (char === '"') {
      const end = sql.indexOf('"', index + 1);
      out += sql.slice(index, end + 1);
      index = end + 1;
    } else if (char !== "'") {
      out += char;
      index++;
    } else {
      let text = '';
      for (index++; ; index++) {
        const next = sql[index];
        if (next === undefined) throw new Error('SQL compilation error: unterminated string');
        if (next === '\\') {
          const escaped = sql[++index]!;
          text += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[escaped] ?? escaped;
        } else if (next === "'" && sql[index + 1] === "'") {
          text += "'";
          index++;
        } else if (next === "'") {
          index++;
          break;
        } else {
          text += next;
        }
      }
      out += rewrite(text);
    }
  }
  return out;
}
const ansiLiteral = (text: string): string => `'${text.replaceAll("'", "''")}'`;

class TableLocks {
  private readonly queues = new Map<string, (() => void)[]>();
  /** Statements refused because the queue for a lock was full. */
  refused = 0;
  async acquire(table: string): Promise<() => void> {
    const queue = this.queues.get(table);
    if (!queue) {
      this.queues.set(table, []);
    } else {
      if (queue.length >= waiterLimit) {
        this.refused++;
        throw Object.assign(
          new Error(
            `Your statement was aborted because the number of waiters for this lock exceeds the ${waiterLimit} statements limit.`
          ),
          { code: '000625', sqlState: '57014' }
        );
      }
      await new Promise<void>((granted) => queue.push(granted));
    }
    return () => {
      const next = this.queues.get(table)!.shift();
      if (next) next();
      else this.queues.delete(table);
    };
  }
}

export interface SnowflakeEmulator {
  integration: SnowflakeIntegration;
  customRunners: CustomRunnerRegistry;
  /** The server-side limit each opened session asked for, in order. */
  statementLimits: (number | undefined)[];
  /** Every statement sent, as sent. */
  statements: string[];
  /** Holds each lock this much longer, so that statements queue behind it. */
  lockHoldMs: number;
  /** How many statements a full lock queue has refused. */
  lockRefusals(): number;
  /** Fails a statement this matches, as a crash before it would, and then stops matching. */
  crashBefore?: RegExp;
  /** Runs SQL on the engine directly, with no emulation. */
  sql(statement: string): Promise<Row[]>;
  close(): Promise<void>;
}

export async function createSnowflakeEmulator(): Promise<SnowflakeEmulator> {
  const engine = await buildDuckDbRunner(memory);
  const locks = new TableLocks();
  let tail: Promise<unknown> = Promise.resolve();
  /** DuckDB has one connection here, so each statement gets it alone, as a whole. */
  const exec = (sql: string, params?: SqlParams): Promise<Row[]> => {
    const next = tail.then(() => engine.query!(sql, params));
    tail = next.catch(() => {});
    return next;
  };
  const translate = (sql: string): string =>
    mapLiterals(sql, ansiLiteral)
      .replaceAll(CLOCK, engineClock)
      .replace('"MEMORY".information_schema', 'information_schema');
  /** What Snowflake would not compile, checked outside string literals. */
  const assertSnowflakeSql = (sql: string): void => {
    const code = mapLiterals(sql, () => "''");
    if (/\bRETURNING\b|\bON\s+CONFLICT\b|\$\d|\bPRIMARY\s+KEY\b/i.test(code)) {
      throw new Error(`SQL compilation error: unsupported syntax in ${code.slice(0, 80)}`);
    }
  };
  const emulator: SnowflakeEmulator = {
    integration,
    customRunners: new CustomRunnerRegistry(),
    statementLimits: [],
    statements: [],
    lockHoldMs: 0,
    lockRefusals: () => locks.refused,
    sql: (statement) => exec(statement),
    close: async () => {
      await tail;
      await engine.close?.();
    },
  };
  const lockedTable = (sql: string): string | undefined =>
    /^\s*(?:UPDATE|DELETE\s+FROM)\s+((?:"[^"]+"\.?)+)/i.exec(sql)?.[1];
  const release = async (unlock: () => void): Promise<void> => {
    if (emulator.lockHoldMs) await delay(emulator.lockHoldMs);
    unlock();
  };
  const dml = async (sql: string, params?: SqlParams): Promise<Row[]> => {
    const update = /^\s*UPDATE\b/i.test(sql);
    if (update || /^\s*DELETE\b/i.test(sql)) {
      const changed = await exec(`${translate(sql)} RETURNING 1 AS changed`, params);
      return update
        ? [
            {
              'number of rows updated': String(changed.length),
              'number of multi-joined rows updated': '0',
            },
          ]
        : [{ 'number of rows deleted': String(changed.length) }];
    }
    const rows = await exec(translate(sql), params);
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([name, value]) => [
          name,
          typeof value === 'number' || typeof value === 'bigint' ? String(value) : value,
        ])
      )
    );
  };
  /** The row store's first-row script, a statement at a time, as a script runs on Snowflake. */
  const runScript = async (script: string): Promise<void> => {
    const lines = script.split('\n');
    const expected = ['BEGIN', 'BEGIN TRANSACTION;'];
    if (
      !/^DECLARE no_guard EXCEPTION \(-20001, '.*'\); matches INTEGER;$/.test(lines[0]!) ||
      expected.some((line, index) => lines[index + 1] !== line) ||
      lines.at(-1) !== 'END;' ||
      lines.at(-2) !== 'EXCEPTION WHEN OTHER THEN ROLLBACK; RAISE;' ||
      lines.at(-3) !== 'COMMIT;'
    ) {
      throw new Error('The emulator supports only the first-row script');
    }
    const held: (() => void)[] = [];
    let matches = 0;
    let rowCount = 0;
    let skipping = false;
    try {
      for (const line of lines.slice(3, -3)) {
        const statement = line.replace(/;$/, '');
        if (statement === 'END IF') {
          skipping = false;
        } else if (skipping) {
          continue;
        } else if (statement === 'IF (SQLROWCOUNT <> 1) THEN RAISE no_guard; END IF') {
          if (rowCount !== 1) throw new Error('Uncaught exception of type NO_GUARD');
        } else if (statement === 'IF (matches = 0) THEN') {
          skipping = matches !== 0;
        } else if (statement.startsWith('matches := (')) {
          const rows = await exec(translate(statement.slice('matches := ('.length, -1)));
          matches = Number(Object.values(rows[0]!)[0]);
        } else {
          const table = lockedTable(statement);
          if (table) held.push(await locks.acquire(table));
          const [result] = await dml(statement);
          rowCount = Number(result?.['number of rows updated'] ?? 0);
        }
        await delay(statementGapMs);
      }
    } finally {
      await Promise.all(held.map(release));
    }
  };
  const execute = async (sql: string, params?: SqlParams): Promise<Row[]> => {
    if (emulator.crashBefore?.test(sql)) {
      delete emulator.crashBefore;
      throw new Error('The connection was lost');
    }
    emulator.statements.push(sql);
    const bound = Array.isArray(params) ? params.map(String).join('') : '';
    if (Buffer.byteLength(sql) + Buffer.byteLength(bound) > statementLimitBytes) {
      throw new Error('The statement is over the 1 MB limit, counting bound values');
    }
    const immediate = /^EXECUTE IMMEDIATE '/.exec(sql);
    if (immediate) {
      let script = '';
      mapLiterals(sql.slice('EXECUTE IMMEDIATE '.length), (text) => (script = text));
      await runScript(script);
      return [{ anonymous_block: null }];
    }
    assertSnowflakeSql(sql);
    const table = lockedTable(sql);
    const unlock = table ? await locks.acquire(table) : undefined;
    try {
      return await dml(sql, params);
    } finally {
      if (unlock) await release(unlock);
    }
  };
  emulator.customRunners.register(
    'snowflake',
    'pat',
    async (_integration, context: RunnerFactoryContext): Promise<SqlRunnerModule> => {
      emulator.statementLimits.push(context.statementTimeoutMs);
      return {
        supportsBindings: true,
        run: async (sql) => {
          await execute(sql);
          return {};
        },
        query: async <T extends Row = Row>(sql: string, params?: SqlParams) =>
          (await execute(sql, params)) as T[],
        close: async () => {},
      };
    }
  );
  return emulator;
}
