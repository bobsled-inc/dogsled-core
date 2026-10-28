-- Model: order_items
-- Description: Order line items joined with product details.
-- Grain: order_item_id
-- Trust: bronze
-- Refs: ecom.raw_order_items, ecom.raw_products
CREATE OR REPLACE VIEW `dogsled_workspace`.`order_items` AS (
SELECT t0.id AS `ORDER_ITEM_ID`, t0.order_id AS `ORDER_ID`, t1.name AS `PRODUCT_NAME`, t0.quantity AS `QUANTITY`, t0.quantity * t1.price AS `LINE_TOTAL` FROM raw.raw_order_items AS t0 LEFT JOIN raw.raw_products AS t1 ON t0.product_id = t1.id
);
