import { publicApi } from './harness.mjs';
const { buildDuckDbRunner } = await publicApi('connections');
const runner = await buildDuckDbRunner({
  spec_version: '1',
  type: 'integration',
  name: 'extension_preparation',
  source_type: 'duckdb',
  connection: { schema: 'main' },
  auth: { type: 'memory' },
});
try {
  await runner.run(
    "INSTALL ducklake; LOAD ducklake; ATTACH 'ducklake:extension-preparation.ducklake' AS prep; CREATE SCHEMA IF NOT EXISTS prep.main; CREATE TABLE prep.main.preparation AS SELECT 1 AS id"
  );
} finally {
  await runner.close?.();
}
