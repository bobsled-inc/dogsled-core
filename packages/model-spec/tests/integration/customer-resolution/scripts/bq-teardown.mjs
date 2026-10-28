import { readFileSync } from 'node:fs';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, '..');
const repoRoot = resolve(__dirname, '../../../../../../');
const require = createRequire(join(repoRoot, 'packages/loader/package.json'));
const { BigQuery } = require('@google-cloud/bigquery');

const configPath = join(projectDir, 'runner.config.json');

async function main() {
  if (!process.argv.includes('--skip-config-check')) {
    try {
      readFileSync(configPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        process.exitCode = 0;
        return;
      }
      throw err;
    }
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (typeof config?.projectId !== 'string' || config.projectId.length === 0) {
    throw new Error('runner.config.json must define a non-empty projectId.');
  }
  if (typeof config?.keyFilename !== 'string' || config.keyFilename.length === 0) {
    throw new Error('runner.config.json must define a non-empty keyFilename.');
  }

  const keyFilename = isAbsolute(config.keyFilename)
    ? config.keyFilename
    : join(projectDir, config.keyFilename);
  const bigquery = new BigQuery({
    projectId: config.projectId,
    keyFilename,
  });

  for (const datasetId of ['raw', 'entity_graph_test']) {
    try {
      const dataset = bigquery.dataset(datasetId);
      const [exists] = await dataset.exists();
      if (exists) {
        await dataset.delete({ force: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|404/i.test(message)) {
        throw error;
      }
    }
  }
}

await main();
