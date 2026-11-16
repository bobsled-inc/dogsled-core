import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildDuckDbRunner } from '@bobsled-inc/connections';
import { verifyOnboarding } from '../../src/runtime/onboarding/verify.js';

it('only accepts article context for an accepted link in the current shortlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-scope-'));
  await mkdir(join(root, 'data/tv-night'), { recursive: true });
  await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
  const runner = await buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'duckdb',
    connection: { schema: 'analytics' },
    auth: { type: 'file', path: join(root, 'scope.duckdb') },
  });
  try {
    await runner.run('CREATE SCHEMA analytics; CREATE SCHEMA sources');
    await runner.run(
      "CREATE TABLE analytics.shows AS SELECT 1 AS id, 'Selected' AS name UNION ALL SELECT 2, 'Other'"
    );
    await runner.run(
      'CREATE TABLE analytics.watch_next AS SELECT * FROM analytics.shows WHERE id = 1'
    );
    await runner.run(
      "CREATE TABLE analytics.show_links AS SELECT 1 AS show_id, 11 AS page_id, 'candidate' AS review_status UNION ALL SELECT 2, 22, 'accepted'"
    );
    await runner.run(
      "CREATE TABLE sources.wikipedia_articles AS SELECT 11 AS page_id, 'Selected' AS title, 1 AS revision_id, 'Text' AS article_text UNION ALL SELECT 22, 'Other', 2, 'Other text'"
    );
    const read = async (_root: string, sql: string) => ({ rows: await runner.query(sql) });
    await expect(verifyOnboarding(root, 'federate', read)).rejects.toThrow(/empty/);
    await runner.run(
      "UPDATE analytics.show_links SET review_status = 'accepted' WHERE show_id = 1"
    );
    const result = await verifyOnboarding(root, 'federate', read);
    expect(result.tables[0]?.rows.map((row) => row.name)).toEqual(['Selected']);
  } finally {
    await runner.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

it('checks every finalist and real watchlist decisions against DuckDB tables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-finalists-'));
  await mkdir(join(root, 'data/tv-night'), { recursive: true });
  await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
  const runner = await buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'duckdb',
    connection: { schema: 'analytics' },
    auth: { type: 'file', path: join(root, 'test.duckdb') },
  });
  try {
    await runner.run(`CREATE SCHEMA analytics;
   CREATE TABLE analytics.watch_next AS SELECT id, 'Series ' || id AS name FROM range(1,4) t(id);
   CREATE TABLE analytics.article_inputs AS SELECT id AS show_id, 10 AS revision_id, 'A story about identity.' AS article_text FROM analytics.watch_next;
   CREATE TABLE analytics.show_notes AS SELECT show_id, revision_id, 'identity' AS theme, 'unknown' AS ending, 'unknown' AS fit, 'identity' AS support_excerpt, 'test' AS _bobsled_run_id FROM analytics.article_inputs;
   CREATE TABLE analytics.recommendations AS SELECT id, name, 'unknown' AS fit, 'The preference needs more evidence.' AS reason FROM analytics.watch_next;
   CREATE TABLE analytics.watchlist_matches AS SELECT 'watch-1' AS watch_id, 'candidate-1' AS candidate_id, 1 AS show_id, 'reviewed' AS match_method, 'Year and country agree after review.' AS evidence, 'accepted' AS review_status UNION ALL SELECT 'watch-2', NULL, NULL, NULL, 'Year missing; cannot choose between remakes.', 'unresolved';`);
    const read = async (_root: string, sql: string) => ({ rows: await runner.query(sql) });
    const result = await verifyOnboarding(root, 'transform', read);
    expect(result.tables[1]?.rows).toHaveLength(3);
    expect((await verifyOnboarding(root, 'resolve', read)).tables[0]?.rows).toHaveLength(2);
    await runner.run('DELETE FROM analytics.show_notes WHERE show_id=3');
    await expect(verifyOnboarding(root, 'transform', read)).rejects.toThrow(/every finalist/);
  } finally {
    await runner.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

it('checks a passage-ID pilot, preserves chapter state, and verifies the remaining results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-passage-pilot-'));
  await mkdir(join(root, 'data/tv-night'), { recursive: true });
  await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
  const runner = await buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'duckdb',
    connection: { schema: 'analytics' },
    auth: { type: 'file', path: join(root, 'pilot.duckdb') },
  });
  try {
    await runner.run(`CREATE SCHEMA analytics;
      CREATE TABLE analytics.watch_next AS SELECT id, 'Series ' || id AS name FROM range(1,4) t(id);
      CREATE TABLE analytics.article_inputs AS SELECT id AS show_id, 10 AS revision_id,
        'Factions compete for power.' AS article_text,
        '[{"id":"p1","text":"Factions compete for power."}]' AS passages FROM analytics.watch_next;
      CREATE TABLE analytics.show_notes AS SELECT show_id, revision_id, ['p1'] AS passage_ids,
        'supported' AS fit, 'The passage describes faction struggles.' AS explanation,
        article_text AS support_excerpt, 'pilot-run' AS _bobsled_run_id FROM analytics.article_inputs WHERE show_id=1;
      CREATE VIEW analytics.recommendations AS SELECT w.id,w.name,n.fit,n.explanation AS reason
        FROM analytics.watch_next w LEFT JOIN analytics.show_notes n ON w.id=n.show_id;`);
    const read = async (_root: string, sql: string) => ({ rows: await runner.query(sql) });
    const pilot = await verifyOnboarding(root, 'transform', read, { showId: 1 });
    expect(pilot.tables[0]?.rows[0]?.['passage_ids']).toBe('["p1"]');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(root, '.bobsled/onboarding/transform.json'))).toBe(false);
    await expect(verifyOnboarding(root, 'transform', read)).rejects.toThrow(/every finalist/);
    await runner.run(`INSERT INTO analytics.show_notes SELECT show_id,revision_id,['p1'],
      'supported','The passage describes faction struggles.',article_text,'remaining-run'
      FROM analytics.article_inputs WHERE show_id IN (2,3)`);
    expect((await verifyOnboarding(root, 'transform', read)).tables[0]?.totalRows).toBe(3);
    expect(
      (await runner.query('SELECT _bobsled_run_id FROM analytics.show_notes WHERE show_id=1'))[0]?.[
        '_bobsled_run_id'
      ]
    ).toBe('pilot-run');
    await runner.run("UPDATE analytics.show_notes SET passage_ids=['p99'] WHERE show_id=2");
    await expect(verifyOnboarding(root, 'transform', read, { showId: 2 })).rejects.toThrow(
      /evidence/
    );
    await runner.run('UPDATE analytics.article_inputs SET revision_id=11 WHERE show_id=1');
    await expect(verifyOnboarding(root, 'transform', read, { showId: 1 })).rejects.toThrow(
      /evidence/
    );
  } finally {
    await runner.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
