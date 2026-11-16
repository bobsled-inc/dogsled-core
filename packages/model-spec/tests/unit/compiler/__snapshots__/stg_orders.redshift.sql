-- Model: stg_orders
-- Description: Staging orders with cleaned fields and computed metrics.
-- Grain: order_id
-- Trust: bronze
-- Refs: ecom.raw_orders
CREATE OR REPLACE VIEW "bobsled_core_workspace"."stg_orders" AS (
SELECT id AS "ORDER_ID", CAST(subtotal / 100.0 AS DECIMAL(16, 2)) AS "SUBTOTAL", DATE_TRUNC('day', ordered_at) AS "ORDERED_AT" FROM raw.raw_orders
);
