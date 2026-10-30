import type { IntegrationFile, SqlRunnerModule } from '@bobsled-inc/connections';

export const checkpointIntegrations: IntegrationFile[] = [
  {
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'postgres',
    connection: { host: 'localhost', database: 'test', port: 5432 },
    auth: { type: 'password', user: 'test', password: 'test-only' },
  },
  {
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'snowflake',
    connection: { account_identifier: 'test', database: 'test', warehouse: 'test', user: 'test' },
    auth: { type: 'pat', token: 'test-only' },
  },
  {
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'bigquery',
    connection: { project_id: 'test-project' },
    auth: { type: 'adc' },
  },
  {
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'databricks',
    connection: { host: 'warehouse.example.com', http_path: '/sql/test', catalog: 'test' },
    auth: { type: 'pat', token: 'test-only' },
  },
];

/** Deterministic transport double, not a SQL engine or a proof of provider transactions. */
export function checkpointTransport(latencyMs = 0, captureInserts = true) {
  let pointer = '';
  let pendingPointer = '';
  let inTransaction = false;
  let publishing = false;
  const payloads = new Map<string, { ordinal: number; data: string }[]>();
  const commit = () => {
    if (!publishing) return;
    publishing = false;
    pointer = pendingPointer;
    for (const id of payloads.keys()) if (id !== pointer) payloads.delete(id);
  };
  const operations: Record<string, number> = {};
  const inserts: { sql: string; params: readonly unknown[] }[] = [];
  let bytes = 0;
  const count = async (operation: string) => {
    operations[operation] = (operations[operation] ?? 0) + 1;
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  };
  const state = {
    payloads,
    operations,
    inserts,
    get pointer() {
      return pointer;
    },
    get bytes() {
      return bytes;
    },
    afterInsert: undefined as undefined | (() => void | Promise<void>),
    failCommit: false,
    valid: true,
    runner: undefined as unknown as SqlRunnerModule,
  };
  state.runner = {
    supportsBindings: true,
    async run(sql) {
      const clean = sql.replaceAll('"', '').replaceAll('`', '').replaceAll("''", "'");
      const match = /SET snapshot = '([a-f0-9-]{36}_[a-f0-9]{64})'/i.exec(clean);
      await count(
        match
          ? 'pointer'
          : /^CREATE/.test(sql)
            ? 'ddl'
            : /^DELETE/.test(sql)
              ? 'cleanup'
              : sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
                ? sql.toLowerCase()
                : 'ownership'
      );
      if (sql === 'BEGIN') inTransaction = true;
      if (match) {
        if (!state.valid) throw new Error('Stale owner');
        pendingPointer = match[1]!;
        publishing = true;
        if (!inTransaction) commit();
      }
      if (sql === 'COMMIT') {
        commit();
        inTransaction = false;
      }
      if (sql === 'ROLLBACK') {
        pendingPointer = pointer;
        publishing = false;
        inTransaction = false;
      }
      if (state.failCommit && (sql === 'COMMIT' || (match && !inTransaction))) {
        state.failCommit = false;
        throw new Error('Lost commit response');
      }
      return {};
    },
    async query(sql, params) {
      const clean = sql.replaceAll('"', '').replaceAll('`', '').replaceAll("''", "'");
      if (/^INSERT/.test(sql)) {
        await count('insert');
        if (!Array.isArray(params)) throw new Error('Expected positional bindings');
        if (captureInserts) inserts.push({ sql, params });
        for (let i = 0; i < params.length; i += 3) {
          const [id, ordinal, data] = params.slice(i, i + 3) as [string, number, string];
          payloads.set(id, [...(payloads.get(id) ?? []), { ordinal, data }]);
          bytes += data.length;
        }
        await state.afterInsert?.();
        return [];
      }
      if (/AS snapshot/i.test(clean)) {
        await count('read_pointer');
        return state.valid ? [{ snapshot: pointer }] : [];
      }
      if (/AS retained/i.test(clean)) {
        await count('retained');
        return [{ retained: 0 }];
      }
      if (/ORDER BY ordinal/i.test(clean)) {
        await count('read_payload');
        return payloads.get(String((params as unknown[])[0])) ?? [];
      }
      if (/DESCRIBE DETAIL/.test(sql)) {
        await count('describe');
        return [{ tablefeatures: ['catalogManaged'] }];
      }
      await count('assertion');
      return [{ valid: state.valid ? 1 : 0 }];
    },
    async close() {},
  };
  return state;
}
