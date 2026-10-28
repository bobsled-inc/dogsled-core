import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../../..');
const require = createRequire(join(repoRoot, 'packages/loader/package.json'));
const { BigQuery } = require('@google-cloud/bigquery');

const configPath = join(__dirname, 'runner.config.json');

function loadConfig() {
  if (!existsSync(configPath)) {
    throw new Error(
      'runner.config.json is required for BigQuery runs. Copy runner.config.json.example and follow the customer-resolution README.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`runner.config.json is invalid JSON: ${message}`);
  }

  if (typeof parsed?.projectId !== 'string' || parsed.projectId.length === 0) {
    throw new Error('runner.config.json must define a non-empty projectId.');
  }
  if (typeof parsed?.keyFilename !== 'string' || parsed.keyFilename.length === 0) {
    throw new Error('runner.config.json must define a non-empty keyFilename.');
  }

  return parsed;
}

const config = loadConfig();
const location = config.location ?? 'US';

const bigquery = new BigQuery({
  projectId: config.projectId,
  keyFilename: isAbsolute(config.keyFilename)
    ? config.keyFilename
    : join(__dirname, config.keyFilename),
});

let bootstrapped = false;
let bootstrapPromise;

async function ensureDatasets() {
  if (bootstrapped) {
    return;
  }
  if (bootstrapPromise) {
    await bootstrapPromise;
    return;
  }

  bootstrapPromise = (async () => {
    for (const datasetId of ['raw', 'entity_graph_test']) {
      const dataset = bigquery.dataset(datasetId);
      const [exists] = await dataset.exists();
      if (!exists) {
        await dataset.create({ location });
      }
    }
    bootstrapped = true;
  })();

  try {
    await bootstrapPromise;
  } finally {
    bootstrapPromise = undefined;
  }
}

export default async function run(sql) {
  await ensureDatasets();
  const [job] = await bigquery.createQueryJob({
    query: sql,
    location,
    useLegacySql: false,
  });
  await job.getQueryResults();
  return { rowCount: undefined };
}

export async function query(sql) {
  await ensureDatasets();
  const [rows] = await bigquery.query({
    query: sql,
    location,
    useLegacySql: false,
  });
  return rows;
}
