/**
 * PostgreSQL warehouse client.
 *
 * Thin subclass of PgCompatibleWarehouseClient — only the dialect name
 * and introspection query differ from the shared base.
 */

import type { Dialect } from './warehouse-client.js';
import type { TableDiscovery } from './warehouse-client.js';
import { PgCompatibleWarehouseClient } from './pg-base-client.js';

export class PostgresWarehouseClient extends PgCompatibleWarehouseClient {
  readonly dialect: Dialect = 'postgres';

  constructor(rawConfig: Record<string, unknown>) {
    super(rawConfig, 'PostgresConfig');
  }

  async introspect(database: string, schema: string): Promise<TableDiscovery[]> {
    // Use pg_catalog for better visibility with restricted users.
    // INFORMATION_SCHEMA has stricter visibility rules.
    const sql = `
      SELECT
        c.relname AS table_name,
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        NOT a.attnotnull AS is_nullable,
        pg_catalog.col_description(c.oid, a.attnum) AS comment,
        CASE WHEN pk_idx.indrelid IS NOT NULL THEN true ELSE false END AS is_primary_key
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      LEFT JOIN (
        SELECT i.indrelid, unnest(i.indkey) AS attnum
        FROM pg_catalog.pg_index i
        WHERE i.indisprimary
      ) pk_idx ON pk_idx.indrelid = c.oid AND pk_idx.attnum = a.attnum
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'v', 'm')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum
    `;

    const tables = new Map<string, TableDiscovery>();

    for await (const batch of this.execute(sql, [schema])) {
      this.processIntrospectionRows(batch, database, schema, tables);
    }

    return Array.from(tables.values());
  }
}
