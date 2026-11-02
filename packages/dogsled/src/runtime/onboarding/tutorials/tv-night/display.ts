import type { OnboardingSnapshot } from '../../schema.js';
import { escapeHtml as e } from '../../html.js';
export function renderAnswer(s: OnboardingSnapshot): string {
  const shortlist = s.state.steps.find((step) => step.id === 'query' && step.status === 'complete')
    ?.evidence?.tables[0];
  const recommendations = s.state.steps
    .find((step) => step.id === 'transform' && step.status === 'complete')
    ?.evidence?.tables.find((table) => table.name === 'Recommendations');
  const answer = recommendations ?? shortlist;
  return answer
    ? answer.rows.length
      ? `<ul>${answer.rows
          .slice(0, 5)
          .map(
            (row) =>
              `<li><strong>${e(row.name ?? row.title ?? row.id)}</strong>${row.fit ? ` · ${e(row.fit)}` : ''}${row.reason ? ` — ${e(row.reason)}` : ''}</li>`
          )
          .join('')}</ul>`
      : '<p>No shows match your current rules. Discuss which constraint to relax with your agent.</p>'
    : '<p>No recommendation yet. Connect to TVmaze, run your ETL, and build a shortlist with your agent.</p>';
}

export const page = {
  title: 'TV Night',
  labels: {
    connect: 'Connect an API',
    load: 'ETL pipeline',
    model: 'Semantic models',
    query: 'Query the data',
    federate: 'Federated queries',
    transform: 'Agentic transformation',
    resolve: 'Entity resolution (optional)',
  },
  titles: { resolve: 'Entity resolution (optional)' },
  expandedTeaching: ['transform'],
  fallbackSource: 'TVmaze API',
  noQuestion: 'No question saved yet. Tell your agent what you want to watch next.',
  preferencesLabel: 'Your viewing preferences',
  noSources: 'No data fetched yet. Connect to TVmaze to begin.',
  intro:
    'Connect an API, build an ETL, describe your data, then query it. Work with your agent, make a small choice, and review each result.',
  table: {
    passageColumns: ['article_text', 'support_excerpt', 'input_passages', 'passages'],
    passageLabel: 'Show passage (may contain spoilers)',
    columnWidths: {
      name: 280,
      title: 280,
      show: 280,
      genres: 280,
      article_text: 384,
      support_excerpt: 384,
      input_passages: 384,
      passages: 384,
      id: 112,
      show_id: 112,
    },
    emptyDescription: 'Connect to TVmaze to begin.',
  },
};
