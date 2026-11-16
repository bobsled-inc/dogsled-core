import { businessRules, expectedSupport, supportIdentity } from './source-checks.js';
import { CommandError } from '@bobsled-inc/protocol';
import type { Evidence, StepId } from '../../schema.js';
import type { CheckOptions, CheckPlan } from '../../tutorial.js';

const counts: Record<string, number> = {
  products: 24,
  suppliers: 4,
  locations: 4,
  sales_orders: 657,
  sales_order_lines: 759,
  returns: 70,
  inventory_daily: 5856,
};
const performance = `SELECT product_id, product_name, ${['sold_units', 'returned_units', 'gross_sales', 'refunds', 'net_sales', 'in_stock_days', 'tracked_days', 'net_sales_per_in_stock_day'].map((name) => `ROUND(CAST(${name} AS DOUBLE), 2) AS ${name}`).join(', ')} FROM product_performance`;
const queries: Record<string, { name: string; sql: string; remote?: boolean }[]> = {
  connect: [
    {
      name: 'API review sample',
      sql: 'SELECT review_id, product_id, rating, review_text, count(*) OVER () AS _total_rows FROM sources.external_reviews LIMIT 5',
    },
  ],
  load: [
    {
      name: 'Warehouse row counts',
      sql: Object.keys(counts)
        .map((name) => `SELECT '${name}' AS source, count(*) AS row_count FROM "${name}"`)
        .join(' UNION ALL '),
    },
  ],
  model: [
    { name: 'Product performance', sql: `${performance} ORDER BY product_id LIMIT 25` },
    businessRules,
  ],
  query: [
    {
      name: 'Products to investigate',
      sql: `${performance} ORDER BY net_sales_per_in_stock_day DESC NULLS LAST, product_id LIMIT 5`,
    },
    businessRules,
  ],
  federate: [
    {
      name: 'Products and reviews',
      sql: "SELECT p.product_id, p.product_name, p.net_sales, r.review_id, r.rating, r.review_text FROM product_performance p JOIN sources.external_reviews r USING (product_id) WHERE r.product_id = 'lmp-009' ORDER BY r.review_id LIMIT 10",
    },
    supportIdentity,
  ],
  transform: [
    {
      name: 'Support findings',
      sql: `${expectedSupport} SELECT c.*, e.product_id AS expected_product_id, e.conversation, p.ticket_id IS NOT NULL AS in_batch, p.product_id IS NOT DISTINCT FROM e.product_id AND p.conversation IS NOT DISTINCT FROM e.conversation AS input_matches_source, (SELECT count(*) FROM support_batch) AS batch_count FROM support_case_classifications c LEFT JOIN support_batch p USING (ticket_id) LEFT JOIN expected_support e ON c.ticket_id = e.ticket_id ORDER BY c.ticket_id LIMIT 6`,
    },
  ],
};
function fail(message: string): never {
  throw new CommandError(message, 2);
}
export function prepareCheck(step: StepId, options: CheckOptions): CheckPlan {
  if (options.showId !== undefined) fail('Use --ticket-id for a retail transformation pilot.');
  const ticket = options.ticketId;
  if (
    ticket !== undefined &&
    (step !== 'transform' || typeof ticket !== 'string' || !/^case-\d{4}$/.test(ticket))
  ) {
    fail('Use --ticket-id with transform and a ticket ID such as case-0001.');
  }
  return {
    queries: (queries[step] ?? []).map((query) => ({
      ...query,
      sql:
        ticket === undefined
          ? query.sql
          : query.sql.replace(
              ' ORDER BY c.ticket_id',
              ` WHERE c.ticket_id = '${ticket}' ORDER BY c.ticket_id`
            ),
    })),
    remote: step === 'connect' || step === 'federate',
    persist: ticket === undefined,
    receipts:
      ticket === undefined
        ? []
        : [
            'Pilot check only. Inspect this case before running the remaining approved batch. Chapter progress is unchanged.',
          ],
  };
}
export function validate(step: StepId, tables: Evidence['tables'], options: CheckOptions): void {
  if (
    tables.length !== queries[step]?.length ||
    tables.some((table) => !table.rows.length || !table.totalRows)
  ) {
    fail('Run the required retail source and model steps before checking this chapter.');
  }
  const rows = tables[0]!.rows;
  if (
    step === 'connect' &&
    rows.some(
      (row) =>
        !row.review_id ||
        !row.product_id ||
        !row.review_text ||
        Number(row.rating) < 1 ||
        Number(row.rating) > 5
    )
  ) {
    fail('Review samples need product identity, text and ratings from 1 to 5.');
  }
  if (
    step === 'load' &&
    (rows.length !== Object.keys(counts).length ||
      new Set(rows.map((row) => row.source)).size !== rows.length ||
      rows.some((row) => Number(row.row_count) !== counts[String(row.source)]))
  ) {
    fail('Load all seven unmodified warehouse fixtures before continuing.');
  }
  if (step === 'model' || step === 'query') {
    if (
      Number(tables[1]?.rows[0]?.compared_rows) !== 24 ||
      Number(tables[1]?.rows[0]?.mismatch_count) !== 0
    ) {
      fail(
        'Compare every product with raw completed orders, refunds and stock days. The model does not match its sources.'
      );
    }
    if (
      rows.length !== (step === 'model' ? 24 : 5) ||
      new Set(rows.map((row) => row.product_id)).size !== rows.length
    ) {
      fail('Keep one performance row per product and inspect the expected comparison.');
    }
    for (const row of rows) {
      const fields = [
        'sold_units',
        'returned_units',
        'gross_sales',
        'refunds',
        'net_sales',
        'in_stock_days',
        'tracked_days',
      ];
      if (
        !row.product_id ||
        !row.product_name ||
        fields.some((key) => typeof row[key] !== 'number' || !Number.isFinite(row[key]))
      ) {
        fail('Product performance needs numeric sales, refunds and stock-day fields.');
      }
      const days = Number(row.in_stock_days);
      if (
        days < 0 ||
        days > 61 ||
        Number(row.tracked_days) !== 61 ||
        Math.abs(Number(row.net_sales) - (Number(row.gross_sales) - Number(row.refunds))) > 0.01 ||
        (days === 0
          ? row.net_sales_per_in_stock_day !== null
          : typeof row.net_sales_per_in_stock_day !== 'number' ||
            Math.abs(row.net_sales_per_in_stock_day - Number(row.net_sales) / days) > 0.01)
      ) {
        fail('Preserve net sales after refunds and distinct product-day stock coverage.');
      }
    }
  }
  if (
    step === 'federate' &&
    (rows.some((row) => row.product_id !== 'lmp-009' || !row.review_id || !row.review_text) ||
      Number(tables[1]!.rows[0]?.case_count) !== 40 ||
      Number(tables[1]!.rows[0]?.ambiguous_count) !== 10 ||
      Number(tables[1]!.rows[0]?.expected_ambiguous_count) !== 10 ||
      Number(tables[1]!.rows[0]?.identity_mismatches) !== 0)
  ) {
    fail('Join reviews by product_id and preserve ambiguous support product identities.');
  }
  if (step === 'transform') {
    const expected = options.ticketId === undefined ? Number(rows[0]?.batch_count) : 1;
    if (
      !Number.isInteger(expected) ||
      expected < 1 ||
      expected > 5 ||
      rows.length !== expected ||
      new Set(rows.map((row) => row.ticket_id)).size !== expected
    ) {
      fail('Classify every case in the approved batch, at most five, with one result per ticket.');
    }
    for (const row of rows) {
      if (
        (options.ticketId !== undefined && row.ticket_id !== options.ticketId) ||
        typeof row.conversation !== 'string' ||
        row.in_batch !== true ||
        row.input_matches_source !== true ||
        row.product_id !== row.expected_product_id ||
        row.analysis_mode !== 'model' ||
        !['product_damage', 'stock_availability', 'positive_feedback', 'other'].includes(
          String(row.issue_category)
        ) ||
        ![
          'replacement_offered',
          'restock_alert',
          'informational',
          'awaiting_customer',
          'other',
        ].includes(String(row.resolution_type)) ||
        typeof row.evidence_summary !== 'string' ||
        !row.evidence_summary.trim() ||
        typeof row.support_quote !== 'string' ||
        !row.support_quote.trim() ||
        !row.conversation.includes(row.support_quote)
      ) {
        fail(
          'Use real model output, preserve product identity, and cite an exact phrase from each supplied conversation. Offline fixture output does not complete the AI lesson.'
        );
      }
    }
  }
}
