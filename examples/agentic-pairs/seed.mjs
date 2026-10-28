import { buildDuckDbRunner } from '@bobsled-inc/dogsled/connections';

const runner = await buildDuckDbRunner({
  spec_version: '1',
  type: 'integration',
  name: 'local',
  source_type: 'duckdb',
  connection: { schema: 'main' },
  auth: { type: 'file', path: './data/pairs.duckdb' },
});

try {
  // All values below are fixed synthetic data. No user input enters this SQL.
  await runner.run(`CREATE OR REPLACE TABLE main.raw_pairs AS
    SELECT * FROM (VALUES
      ('pair-1', 'record-101', 'record-102',
       'Both records have the same verified account identifier: synthetic-account-1.',
       'undecided'),
      ('pair-2', 'record-201', 'record-202',
       'Verified account identifiers conflict: synthetic-account-2 and synthetic-account-3.',
       'undecided'),
      ('pair-3', 'record-301', 'record-302',
       'Both records use the display label Sample User. No verified account identifier is available.',
       'undecided'),
      ('pair-4', 'record-401', 'record-402',
       'This pair was already decided. It must not enter the assessment model.',
       'decided')
    ) AS pairs(pair_id, left_record, right_record, prepared_evidence, status)`);
} finally {
  await runner.close?.();
}
