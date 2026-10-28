CREATE SCHEMA IF NOT EXISTS raw;
CREATE TABLE raw.orders (
  order_id BIGINT,
  customer_id BIGINT,
  gross_amount DECIMAL(18,2),
  discount DECIMAL(18,2)
);
INSERT INTO raw.orders VALUES (1, 10, 100.00, 10.00), (2, 20, 50.00, 5.00);
CREATE TABLE raw.customers (customer_id BIGINT, customer_name VARCHAR);
INSERT INTO raw.customers VALUES (10, 'Ada'), (20, 'Lin');
