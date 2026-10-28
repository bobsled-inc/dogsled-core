import { parsePositiveInt } from '@bobsled-inc/protocol';
import { Command } from 'commander';

export function addDatabaseDestinationOptions(command: Command): void {
  command
    .option('--databricks-host <host>', 'Databricks server hostname')
    .option('--databricks-http-path <path>', 'Databricks SQL warehouse HTTP path')
    .option('--databricks-catalog <catalog>', 'Databricks catalog')
    .option('--databricks-schema <schema>', 'Databricks schema')
    .option('--databricks-token <token>', 'Databricks access token')
    .option('--databricks-oauth-client-id <id>', 'Databricks OAuth client ID')
    .option('--databricks-oauth-client-secret <secret>', 'Databricks OAuth client secret')
    .option('--postgres-host <host>', 'Postgres host')
    .option('--postgres-port <port>', 'Postgres port', parsePositiveInt)
    .option('--postgres-database <db>', 'Postgres database')
    .option('--postgres-schema <schema>', 'Postgres schema')
    .option('--postgres-user <user>', 'Postgres username')
    .option('--postgres-password <pass>', 'Postgres password')
    .option('--postgres-ssl', 'Postgres SSL')
    .option('--mysql-host <host>', 'MySQL host')
    .option('--mysql-port <port>', 'MySQL port', parsePositiveInt)
    .option('--mysql-database <database>', 'MySQL database name')
    .option('--mysql-user <user>', 'MySQL user')
    .option('--mysql-password <password>', 'MySQL password')
    .option('--mysql-ssl', 'Use SSL for MySQL connection')
    .option('--clickhouse-host <host>', 'ClickHouse host')
    .option('--clickhouse-port <port>', 'ClickHouse HTTP port', parsePositiveInt)
    .option('--clickhouse-database <db>', 'ClickHouse database')
    .option('--clickhouse-username <user>', 'ClickHouse username')
    .option('--clickhouse-password <pass>', 'ClickHouse password')
    .option('--clickhouse-ssl', 'Use HTTPS for the ClickHouse connection')
    .option('--clickhouse-vector-index', 'Create vector_similarity indexes for vector columns')
    .option('--turbopuffer-api-key <key>', 'Turbopuffer API key')
    .option('--turbopuffer-region <region>', 'Turbopuffer region')
    .option('--turbopuffer-namespace-prefix <prefix>', 'Turbopuffer namespace prefix')
    .option('--turbopuffer-distance-metric <metric>', 'cosine_distance or euclidean_squared')
    .option('--turbopuffer-full-text-columns <cols>', 'Comma-separated columns to index for BM25');
}
