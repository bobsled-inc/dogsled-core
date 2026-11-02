import { CommandError } from '@bobsled-inc/protocol';
import type { Evidence, StepId } from '../../schema.js';
import type { CheckOptions, CheckPlan } from '../../tutorial.js';
import { checkAssessment } from './assessment.js';
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

export function validate(step: StepId, tables: Evidence['tables'], options: CheckOptions): void {
  const pilot = options.showId !== undefined;
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
        throw new CommandError('Transformation evidence must belong to the current shortlist.', 2);
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
}

export function prepareCheck(step: StepId, options: CheckOptions): CheckPlan {
  if (options.ticketId !== undefined) {
    throw new CommandError('Use --show-id for a TV Night pilot.', 2);
  }
  const pilot = options.showId !== undefined;
  if (
    pilot &&
    (step !== 'transform' ||
      typeof options.showId !== 'number' ||
      !Number.isSafeInteger(options.showId) ||
      options.showId < 1)
  ) {
    throw new CommandError('Use --show-id with transform and a positive integer TVmaze ID.', 2);
  }
  return {
    queries: (queries[step] ?? []).map((query) => ({
      ...query,
      sql: pilot
        ? query.sql.replace(
            / LIMIT (\d+)$/,
            ` WHERE ${query.name === 'Recommendations' ? 'id' : 'n.show_id'} = ${options.showId} LIMIT $1`
          )
        : query.sql,
    })),
    remote: step === 'connect' || step === 'federate',
    persist: !pilot,
    receipts: pilot
      ? [
          'Pilot check only: inspect this show before running the remaining finalists. Chapter progress is unchanged.',
        ]
      : [],
  };
}

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(
        ([key, value]) =>
          (key !== '_passage_ids_json' || value !== null) &&
          (key !== 'passage_ids' || row['_passage_ids_json'] == null)
      )
      .map(([key, value]) => [key === '_passage_ids_json' ? 'passage_ids' : key, value])
  );
}
