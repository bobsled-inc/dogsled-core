// These checks derive expected values from raw sources, independently of the
// learner's models. Internally consistent output can still use the wrong rule.
export const businessRules = {
  name: 'Source business-rule checks',
  sql: `WITH refunds AS (
    SELECT order_line_id, sum(quantity) AS returned_units, sum(refund_amount) AS refunds
    FROM returns GROUP BY order_line_id
  ), sales AS (
    SELECT l.product_id, sum(l.quantity) AS sold_units,
      sum(coalesce(r.returned_units, 0)) AS returned_units,
      sum(l.quantity * l.unit_price - l.discount_amount) AS gross_sales,
      sum(coalesce(r.refunds, 0)) AS refunds
    FROM sales_order_lines l JOIN sales_orders o USING (order_id)
    LEFT JOIN refunds r USING (order_line_id)
    WHERE o.status = 'completed' GROUP BY l.product_id
  ), stock AS (
    SELECT product_id, count(DISTINCT snapshot_date) AS tracked_days,
      count(DISTINCT CASE WHEN available_units > 0 THEN snapshot_date END) AS in_stock_days
    FROM inventory_daily GROUP BY product_id
  ), expected AS (
    SELECT p.product_id, p.product_name, coalesce(s.sold_units, 0) AS sold_units,
      coalesce(s.returned_units, 0) AS returned_units,
      coalesce(s.gross_sales, 0) AS gross_sales, coalesce(s.refunds, 0) AS refunds,
      coalesce(s.gross_sales, 0) - coalesce(s.refunds, 0) AS net_sales,
      coalesce(k.tracked_days, 0) AS tracked_days, coalesce(k.in_stock_days, 0) AS in_stock_days
    FROM products p LEFT JOIN sales s USING (product_id) LEFT JOIN stock k USING (product_id)
  ) SELECT count(*) AS compared_rows, count(*) FILTER (WHERE
    e.product_id IS NULL OR a.product_id IS NULL OR
    (a.product_name, a.sold_units, a.returned_units,
      round(a.gross_sales, 2), round(a.refunds, 2), round(a.net_sales, 2),
      a.tracked_days, a.in_stock_days, round(a.net_sales_per_in_stock_day, 2))
    IS DISTINCT FROM
    (e.product_name, e.sold_units, e.returned_units,
      round(e.gross_sales, 2), round(e.refunds, 2), round(e.net_sales, 2),
      e.tracked_days, e.in_stock_days,
      round(e.net_sales / nullif(e.in_stock_days, 0), 2))
  ) AS mismatch_count
  FROM expected e FULL OUTER JOIN product_performance a USING (product_id)`
    .replace(/\s+/g, ' ')
    .trim(),
};

export const expectedSupport = `WITH expected_support AS (
  SELECT t.ticket_id,
    CASE WHEN t.order_line_id IS NOT NULL THEN
      max(CASE WHEN l.order_line_id = t.order_line_id THEN l.product_id END)
    WHEN count(DISTINCT l.product_id) = 1 THEN max(l.product_id) ELSE NULL END AS product_id,
    max(t.message || ' Agent response: ' || t.agent_reply) AS conversation
  FROM support_tickets t LEFT JOIN sales_order_lines l ON t.order_id = l.order_id
  GROUP BY t.ticket_id, t.order_line_id
)`;
export const supportIdentity = {
  name: 'Support identity',
  remote: false,
  sql: `${expectedSupport}
    SELECT (SELECT count(*) FROM prepared_support_cases) AS case_count,
      count(*) FILTER (WHERE p.product_id IS NULL) AS ambiguous_count,
      count(*) FILTER (WHERE e.product_id IS NULL) AS expected_ambiguous_count,
      count(*) FILTER (WHERE p.ticket_id IS NULL OR
        p.product_id IS DISTINCT FROM e.product_id OR
        p.conversation IS DISTINCT FROM e.conversation) AS identity_mismatches
    FROM expected_support e LEFT JOIN prepared_support_cases p USING (ticket_id)`,
};
