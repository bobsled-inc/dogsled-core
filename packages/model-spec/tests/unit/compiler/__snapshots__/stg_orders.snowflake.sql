-- Model: stg_orders
-- Description: Staging orders with cleaned fields and computed metrics.
-- Grain: order_id
-- Trust: bronze
-- Refs: ecom.raw_orders
CREATE OR REPLACE VIEW "DOGSLED_WORKSPACE"."STG_ORDERS" COPY GRANTS AS (
SELECT ID AS ORDER_ID, CAST(SUBTOTAL / 100.0 AS DECIMAL(16, 2)) AS SUBTOTAL, DATE_TRUNC('DAY', ORDERED_AT) AS ORDERED_AT FROM RAW.RAW_ORDERS
);
