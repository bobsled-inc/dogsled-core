/**
 * One real run on a shared store, in a process of its own so that runs contend at the database
 * rather than for one event loop. See row-store-contention-run.ts for what it measures.
 */
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRunner, type IntegrationFile } from '@bobsled-inc/connections';
import { snowflakeRowDialect } from '../../src/agentic/warehouse-row-dialects.js';
import {
  runContention,
  type ContentionRunOptions,
  type ContentionRunResult,
} from './row-store-contention-run.js';
import {
  hostRunners,
  postgresIntegration,
  snowflakeIntegration,
} from './row-store-integrations.js';

export interface ContentionWorkerOptions extends ContentionRunOptions {
  engine: 'postgres' | 'snowflake';
  /** Header tables on Snowflake, in place of the dialect's own number. */
  headerTables?: number;
  /** Epoch milliseconds at which every worker starts. */
  startAt: number;
  output: string;
}
export type ContentionWorkerResult = ContentionRunResult;

const options = JSON.parse(process.argv[2]!) as ContentionWorkerOptions;

async function main(): Promise<void> {
  if (options.headerTables) {
    Object.assign(snowflakeRowDialect, { headerTables: [options.headerTables] });
  }
  const integration: IntegrationFile =
    options.engine === 'postgres' ? postgresIntegration() : (await snowflakeIntegration())!;
  const host = await hostRunners();
  await delay(Math.max(0, options.startAt - Date.now()));
  const result = await runContention(options, integration, (base, context) =>
    resolveRunner(base, { ...context, ...host })
  );
  writeFileSync(options.output, JSON.stringify(result));
}

await main();
