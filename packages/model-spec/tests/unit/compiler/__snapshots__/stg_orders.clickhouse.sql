-- Model: stg_orders
-- Description: Staging orders with cleaned fields and computed metrics.
-- Grain: order_id
-- Trust: bronze
-- Refs: ecom.raw_orders
CREATE OR REPLACE VIEW `BOBSLED_CORE_WORKSPACE`.`stg_orders` AS (
SELECT ID AS "ORDER_ID", CAST(SUBTOTAL / 100.0 AS Decimal(16, 2)) AS "SUBTOTAL", dateTrunc('day', ORDERED_AT) AS "ORDERED_AT" FROM RAW.RAW_ORDERS
);
