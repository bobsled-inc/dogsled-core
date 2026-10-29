import { checkAssessment } from './assessment.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError } from '@bobsled-inc/protocol';
import { z } from 'zod';
import { Evidence, PreviewTable, type StepId } from './schema.js';
import { inputHash, saveCheckpoint, saveAttempt } from './state.js';

const queries: Record<StepId, { name: string; sql: string }[]> = {
  connect: [
    { name: 'TVmaze connection', sql: 'SELECT id, name FROM sources.tvmaze_probe LIMIT 5' },
  ],
  load: ['shows', 'episodes'].map((name) => ({
    name: `Raw ${name}`,
    sql: `SELECT * EXCLUDE (_time_extracted, _dogsled_loaded_at), count(*) OVER () AS _total_rows FROM raw.${name} LIMIT 500`,
  })),
  model: [
    {
      name: 'Shows',
      sql: 'SELECT *, count(*) OVER () AS _total_rows FROM analytics.shows LIMIT 500',
    },
    {
      name: 'Episodes',
      sql: 'SELECT *, count(*) OVER () AS _total_rows FROM analytics.episodes LIMIT 500',
    },
  ],
  query: [
    {
      name: 'Your shortlist',
      sql: 'SELECT *, count(*) OVER () AS _total_rows FROM analytics.watch_next LIMIT 6',
    },
  ],
  federate: [
    {
      name: 'Shows with article context',
      sql: "SELECT s.id, s.name, l.page_id, a.title, a.revision_id, a.article_text, (SELECT count(*) FROM analytics.watch_next) AS finalist_count FROM analytics.watch_next s JOIN analytics.show_links l ON s.id = l.show_id JOIN sources.wikipedia_articles a ON l.page_id = a.page_id WHERE l.review_status = 'accepted' LIMIT 6",
    },
  ],
  transform: [
    {
      name: 'Supported show notes',
      sql: "SELECT n.*, json_extract_string(to_json(n), '$.passage_ids') AS _passage_ids_json, i.article_text, json_extract_string(to_json(i), '$.passages') AS input_passages, w.id IS NOT NULL AS in_shortlist, (SELECT count(*) FROM analytics.watch_next) AS finalist_count, count(*) OVER () AS _total_rows FROM analytics.show_notes n LEFT JOIN analytics.article_inputs i ON n.show_id = i.show_id AND n.revision_id = i.revision_id LEFT JOIN analytics.watch_next w ON n.show_id = w.id LIMIT 6",
    },
    {
      name: 'Recommendations',
      sql: 'SELECT *, count(*) OVER () AS _total_rows FROM analytics.recommendations LIMIT 6',
    },
  ],
  resolve: [
    {
      name: 'Watchlist matches',
      sql: 'SELECT watch_id, candidate_id, show_id, match_method, evidence, review_status FROM analytics.watchlist_matches LIMIT 100',
    },
  ],
};
export type CliReader = (root: string, sql: string, remote: boolean) => Promise<unknown>;
export const readWithCli: CliReader = async (root, sql, remote) => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dirname(dir) !== dir) {
    const pkg = join(dir, 'package.json');
    if (
      existsSync(pkg) &&
      (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@bobsled-inc/dogsled'
    ) {
      break;
    }
    dir = dirname(dir);
  }
  const cli = join(dir, 'bin/cli.mjs');
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        cli,
        ...(remote
          ? ['--json', 'source-query', sql]
          : ['query', sql, '--db-path', '.dogsled/dogsled.duckdb']),
      ],
      {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', DOGSLED_OUTPUT_FORMAT: 'json' },
      }
    );
    return JSON.parse(stdout);
  } catch {
    throw new CommandError(
      'The data check failed. Run the step in your agent and inspect its command output, then verify again.',
      1
    );
  }
};
const Result = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).max(500),
  receipts: z.array(z.string().max(2000)).max(100).optional(),
});
export async function verifyOnboarding(
  root: string,
  step: StepId,
  read: CliReader = readWithCli,
  options: { showId?: number } = {}
): Promise<Evidence> {
  const pilot = options.showId !== undefined;
  if (
    pilot &&
    (step !== 'transform' || !Number.isSafeInteger(options.showId) || options.showId! < 1)
  ) {
    throw new CommandError('Use --show-id with transform and a positive integer TVmaze ID.', 2);
  }
  const before = await inputHash(root, step);
  if (!pilot) await saveAttempt(root, step, 'running', before);
  try {
    const tables: z.infer<typeof PreviewTable>[] = [];
    const receipts: string[] = pilot
      ? [
          'Pilot check only: inspect this show before running the remaining finalists. Chapter progress is unchanged.',
        ]
      : [];
    for (const query of queries[step]) {
      const sql = pilot
        ? query.sql.replace(
            / LIMIT (\d+)$/,
            ` WHERE ${query.name === 'Recommendations' ? 'id' : 'n.show_id'} = ${options.showId} LIMIT $1`
          )
        : query.sql;
      const result = Result.parse(await read(root, sql, step === 'federate' || step === 'connect'));
      const totalRows = Number(result.rows[0]?.['_total_rows'] ?? result.rows.length);
      const rows = result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row)
            .filter(
              ([key, value]) =>
                key !== '_total_rows' &&
                (key !== '_passage_ids_json' || value !== null) &&
                (key !== 'passage_ids' || row['_passage_ids_json'] == null)
            )
            .map(([key, value]) => [
              key === '_passage_ids_json' ? 'passage_ids' : key,
              typeof value === 'bigint'
                ? String(value)
                : value !== null && typeof value === 'object'
                  ? JSON.stringify(value, (_key, nested) =>
                      typeof nested === 'bigint' ? String(nested) : nested
                    )
                  : value,
            ])
        )
      );
      tables.push(
        PreviewTable.parse({
          name: query.name,
          columns: Object.keys(rows[0] ?? {}),
          rows,
          totalRows,
        })
      );
      receipts.push(sql, ...(result.receipts ?? []));
    }
    if (
      (step === 'load' ||
        step === 'model' ||
        step === 'transform' ||
        step === 'resolve' ||
        step === 'federate' ||
        step === 'connect') &&
      tables.some((t) => t.totalRows === 0)
    ) {
      throw new CommandError(
        'A required table is empty. Connect the source, run your ETL, and build the required models first.',
        2
      );
    }
    if (step === 'query' && (tables[0]?.totalRows ?? 0) > 5) {
      throw new CommandError(
        'Choose at most five finalists in watch_next before enriching the shortlist.',
        2
      );
    }
    if (step === 'federate' || step === 'transform') {
      const rows = tables[0]?.rows ?? [];
      const expected = pilot ? 1 : Number(rows[0]?.['finalist_count'] ?? rows.length);
      const ids = new Set(rows.map((r) => r[step === 'federate' ? 'id' : 'show_id']));
      if (expected > 5 || ids.size !== expected || rows.length !== expected) {
        throw new CommandError(
          'Fetch and assess every finalist, with one note and one article per show (at most five). Missing evidence must stay visible.',
          2
        );
      }
    }
    if (step === 'transform') {
      if ((tables[0]?.totalRows ?? 0) > 5) {
        throw new CommandError('Enrich at most five shortlisted shows per run.', 2);
      }
      const recommendations = tables[1]?.rows ?? [];
      const noteIds = new Set(tables[0]?.rows.map((row) => String(row['show_id'])));
      if (
        recommendations.length !== noteIds.size ||
        new Set(recommendations.map((row) => String(row['id']))).size !== noteIds.size ||
        recommendations.some(
          (row) =>
            !noteIds.has(String(row['id'])) ||
            !['supported', 'contradicted', 'mixed', 'unknown'].includes(String(row['fit'])) ||
            typeof row['reason'] !== 'string' ||
            !row['reason'].trim()
        )
      ) {
        throw new CommandError(
          'Build recommendations for every finalist with its fit, evidence and unknowns before completing this chapter.',
          2
        );
      }
      const seen = new Set<unknown>();

      for (const row of tables[0]?.rows ?? []) {
        if (row['in_shortlist'] !== true) {
          throw new CommandError(
            'Transformation evidence must belong to the current shortlist.',
            2
          );
        }
        if (seen.has(row['show_id'])) {
          throw new CommandError('Keep one note and revision per shortlisted show.', 2);
        }
        seen.add(row['show_id']);
        if (pilot && String(row['show_id']) !== String(options.showId)) {
          throw new CommandError('Pilot evidence must belong to the requested show.', 2);
        }
        checkAssessment(row);
      }
    }
    if (
      step === 'resolve' &&
      tables[0]?.rows.some(
        (row) =>
          !row['watch_id'] ||
          !row['evidence'] ||
          !['accepted', 'rejected', 'unresolved'].includes(String(row['review_status'])) ||
          (row['review_status'] === 'accepted' &&
            (!row['show_id'] ||
              !row['candidate_id'] ||
              !['shared_id', 'reviewed'].includes(String(row['match_method']))))
      )
    ) {
      throw new CommandError(
        'Watchlist evidence needs source IDs and a reason for each accepted, rejected or unresolved decision.',
        2
      );
    }
    if ((await inputHash(root, step)) !== before) {
      throw new CommandError('Inputs changed during the check. Verify again.', 3);
    }
    const evidence = Evidence.parse({
      mode: step === 'federate' || step === 'connect' ? 'live' : 'offline',
      tables,
      receipts,
    });
    if (!pilot) await saveCheckpoint(root, step, evidence);
    if (!pilot) await saveAttempt(root, step, 'complete', before);
    return evidence;
  } catch (error) {
    if (!pilot) await saveAttempt(root, step, 'failed', before);
    throw error;
  }
}
