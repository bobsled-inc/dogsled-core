import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildDuckDbRunner } from '@bobsled-inc/connections';
import { SourceSpecSchema, resolveSourceEntry } from '@bobsled-inc/model-spec';
import { runQueryCommand } from '../../src/runtime/lazy-query-engine.js';
import type { ApiResourceEntry } from '../../src/runtime/source-materializer/load-specs.js';

it('joins remote Wikipedia rows to local shows in the configured DuckDB and exposes cache receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-federation-'));
  try {
    const dbPath = join(root, 'tv.duckdb');
    const runner = await buildDuckDbRunner({
      spec_version: '1',
      type: 'integration',
      name: 'warehouse',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: dbPath },
    });
    await runner.run("CREATE TABLE catalog AS SELECT 42 AS page_id, 'Example series' AS name");
    await runner.close?.();
    const entry = resolveSourceEntry(
      SourceSpecSchema.parse({
        spec_version: '0.2',
        type: 'source',
        name: 'articles',
        source_type: 'api_resource',
        integration: 'wikipedia',
        resource: 'articles',
        connection: 'warehouse',
        mode: 'lazy',
        max_age: '1h',
        schema: {
          columns: [
            { name: 'page_id', type: 'INTEGER' },
            { name: 'article_text', type: 'VARCHAR' },
          ],
        },
      })
    ) as ApiResourceEntry;
    const args = {
      projectRoot: root,
      sql: 'SELECT c.name, p.article_text FROM catalog c JOIN sources.articles p ON c.page_id = p.page_id LIMIT 5',
      apiResourceEntries: [entry],
      defaultDestination: { dest: 'duckdb', dbPath, targetSchema: 'cache' },
      integrationSpecLoader: () => ({ integration: {} as never, resource: {} as never }),
      queryResourceImpl: async () => ({
        records: [
          { page_id: 42, article_text: 'A story about identity.' },
          { page_id: 99, article_text: 'Different series.' },
        ],
        limitReached: false,
      }),
    };
    const first = await runQueryCommand(args);
    expect(first.rows).toEqual([
      { name: 'Example series', article_text: 'A story about identity.' },
    ]);
    expect(first.receipts.join(' ')).toContain('action=materialized');
    const second = await runQueryCommand({
      ...args,
      queryResourceImpl: async () => {
        throw new Error('Should use cached rows');
      },
    });
    expect(second.rows).toEqual(first.rows);
    expect(second.receipts.join(' ')).toContain('action=reused');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
