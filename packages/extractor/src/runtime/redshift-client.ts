/**
 * Amazon Redshift warehouse client.
 *
 * Thin subclass of PgCompatibleWarehouseClient — only the dialect name
 * and introspection query differ from the shared base.
 */

import type { Dialect } from './warehouse-client.js';
import type { TableDiscovery } from './warehouse-client.js';
import { PgCompatibleWarehouseClient } from './pg-base-client.js';

export class RedshiftWarehouseClient extends PgCompatibleWarehouseClient {
  readonly dialect: Dialect = 'redshift';

  constructor(rawConfig: Record<string, unknown>) {
    super(rawConfig, 'RedshiftConfig');
  }

  async introspect(database: string, schema: string): Promise<TableDiscovery[]> {
    // Use information_schema.columns for broadest Redshift compatibility.
    // Join with table_constraints/key_column_usage for primary key detection.
    const sql = `
      SELECT
        c.table_name,
        c.column_name,
        c.data_type,
        CASE WHEN c.is_nullable = 'YES' THEN true ELSE false END AS is_nullable,
        CASE WHEN kcu.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN information_schema.table_constraints tc
        ON tc.table_schema = c.table_schema
        AND tc.table_name = c.table_name
        AND tc.constraint_type = 'PRIMARY KEY'
      LEFT JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
        AND kcu.table_name = tc.table_name
        AND kcu.column_name = c.column_name
      WHERE c.table_schema = $1
      ORDER BY c.table_name, c.ordinal_position
    `;

    const tables = new Map<string, TableDiscovery>();

    for await (const batch of this.execute(sql, [schema])) {
      this.processIntrospectionRows(batch, database, schema, tables);
    }

    return Array.from(tables.values());
  }
}
