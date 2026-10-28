-- Model: order_items
-- Description: Order line items joined with product details.
-- Grain: order_item_id
-- Trust: bronze
-- Refs: ecom.raw_order_items, ecom.raw_products
CREATE OR REPLACE VIEW "DOGSLED_WORKSPACE"."ORDER_ITEMS" COPY GRANTS AS (
SELECT T0.ID AS ORDER_ITEM_ID, T0.ORDER_ID AS ORDER_ID, T1.NAME AS PRODUCT_NAME, T0.QUANTITY AS QUANTITY, T0.QUANTITY * T1.PRICE AS LINE_TOTAL FROM RAW.RAW_ORDER_ITEMS AS T0 LEFT JOIN RAW.RAW_PRODUCTS AS T1 ON T0.PRODUCT_ID = T1.ID
);
