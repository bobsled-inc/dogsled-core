# Hearth & Home business definitions

Hearth & Home is a fictional midsized home-goods retailer with an online channel and three stores. Product catalog, supplier unit cost, order headers, order lines, returns and daily inventory snapshots come from the warehouse. Customer reviews and support conversations are separate API streams.

## Product identity

`product_id` is the stable product key across catalog, sales, inventory, reviews and support evidence. Use this key for every join. `order_line_id` links a return to the exact sold product and links unambiguous support cases to a product. A support case with no line key and more than one distinct product in its order has no resolved product; leave it null.

## Money and sales

- A cancelled order contributes no sales, units or returns to product performance.
- `gross_sales` is completed order line quantity times listed unit price less the line's discount.
- `refunds` is the return ledger amount, already prorated for the sold units' discount.
- `net_sales` is gross sales minus refunds. It is not cash collected after tax or shipping.
- `net_units` is sold units minus returned units. It can differ from order count because orders can have multiple lines.
- Supplier `unit_cost` is reference catalog cost. The fixture does not include freight, labor, tax or time-varying cost, so it is not a full margin ledger.

## Availability and sales rate

`inventory_daily` records opening-of-day sellable units by product and location. Returns are treated as quarantined and do not re-enter sellable inventory in this fixture. A product is in stock for a date when the sum of opening units across all locations is above zero. `in_stock_days` counts those distinct calendar dates once per product, not one row per location. `net_sales_per_in_stock_day` divides product net sales across the complete fixture window by these product-days. It is an observed sales-rate proxy; it does not infer unobserved demand or lost sales.

## External evidence

Reviews preserve the written rating and text. Support input includes customer message and the recorded agent response. The agentic model should return typed issue and resolution categories with Dogsled evidence metadata. It must preserve a null product when the order lines cannot identify one. Classification output is advice for analysis and does not trigger a refund, replacement, restock, or customer contact.
