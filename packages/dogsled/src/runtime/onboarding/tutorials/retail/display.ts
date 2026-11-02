import type { TutorialDefinition } from '../../tutorial.js';
import type { OnboardingSnapshot } from '../../schema.js';
import { escapeHtml as e } from '../../html.js';
export const page: TutorialDefinition['page'] = {
  title: 'Retail',
  labels: {},
  titles: {},
  expandedTeaching: ['transform'],
  fallbackSource: 'Warehouse exports and Retail API',
  noQuestion: 'Which products need attention?',
  preferencesLabel: 'Your business question',
  noSources: 'Connect your retail sources to begin.',
  intro:
    'Explore sales, stock and customer feedback for a fictional retailer. Build each step with your agent and inspect the evidence before continuing.',
  table: {
    passageColumns: ['review_text', 'conversation', 'support_quote', 'evidence_summary'],
    passageLabel: 'Read customer evidence',
    columnWidths: { product_name: 240, review_text: 384, conversation: 384, support_quote: 384 },
    emptyDescription: 'Connect the retail sources to begin.',
  },
};
export function renderAnswer(snapshot: OnboardingSnapshot): string {
  const table = snapshot.state.steps.find(
    (step) => step.id === 'query' && step.status === 'complete'
  )?.evidence?.tables[0];
  return table
    ? `<p>Products to investigate; these are observations, not automatic business actions.</p><ul>${table.rows.map((row) => `<li><strong>${e(row.product_name)}</strong> · ${e(row.net_sales)} net sales · ${e(row.in_stock_days)} in-stock days</li>`).join('')}</ul>`
    : '<p>Load the warehouse and build product performance to start comparing products.</p>';
}
