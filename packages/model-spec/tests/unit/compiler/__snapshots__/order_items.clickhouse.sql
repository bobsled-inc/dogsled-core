-- Model: order_items
-- Description: Order line items joined with product details.
-- Grain: order_item_id
-- Trust: bronze
-- Refs: ecom.raw_order_items, ecom.raw_products
CREATE OR REPLACE VIEW `BOBSLED_CORE_WORKSPACE`.`order_items` AS (
SELECT t0.ID AS "ORDER_ITEM_ID", t0.ORDER_ID AS "ORDER_ID", t1.NAME AS "PRODUCT_NAME", t0.QUANTITY AS "QUANTITY", t0.QUANTITY * t1.PRICE AS "LINE_TOTAL" FROM RAW.RAW_ORDER_ITEMS AS t0 LEFT JOIN RAW.RAW_PRODUCTS AS t1 ON t0.PRODUCT_ID = t1.ID
);
