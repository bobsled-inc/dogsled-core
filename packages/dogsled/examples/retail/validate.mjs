import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
function parseCsv(text) {
  const [headerLine, ...lines] = text.trimEnd().split('\n');
  const headers = headerLine.split(',');
  return lines.map((line) => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        values.push(value);
        value = '';
      } else value += ch;
    }
    values.push(value);
    assert.equal(values.length, headers.length, 'CSV row width matches header');
    return Object.fromEntries(headers.map((key, i) => [key, values[i]]));
  });
}
async function csv(name) {
  return parseCsv(await readFile(resolve(root, 'data/retail', name), 'utf8'));
}
const [products, suppliers, locations, orders, lines, returns, inventory] = await Promise.all([
  csv('products.csv'),
  csv('suppliers.csv'),
  csv('locations.csv'),
  csv('sales_orders.csv'),
  csv('sales_order_lines.csv'),
  csv('returns.csv'),
  csv('inventory_daily.csv'),
]);
const reviews = JSON.parse(await readFile(resolve(root, 'data/retail/api/reviews.json'), 'utf8'));
const tickets = JSON.parse(
  await readFile(resolve(root, 'data/retail/api/support-tickets.json'), 'utf8')
);
const ids = (rows, key) => new Set(rows.map((row) => row[key]));
const productIds = ids(products, 'product_id');
const supplierIds = ids(suppliers, 'supplier_id');
const locationIds = ids(locations, 'location_id');
const orderById = new Map(orders.map((row) => [row.order_id, row]));
const lineById = new Map(lines.map((row) => [row.order_line_id, row]));
assert.equal(productIds.size, products.length, 'product IDs unique');
assert.equal(ids(orders, 'order_id').size, orders.length, 'order IDs unique');
assert.equal(ids(lines, 'order_line_id').size, lines.length, 'line IDs unique');
for (const p of products)
  assert(supplierIds.has(p.supplier_id), `supplier exists for ${p.product_id}`);
for (const line of lines) {
  assert(orderById.has(line.order_id), `order exists for line ${line.order_line_id}`);
  assert(productIds.has(line.product_id), `product exists for line ${line.order_line_id}`);
  assert(
    Number(line.quantity) > 0 && Number(line.unit_price) > 0,
    `positive quantity and price for ${line.order_line_id}`
  );
  assert(
    Number(line.discount_amount) >= 0 &&
      Number(line.discount_amount) <= Number(line.unit_price) * Number(line.quantity),
    `valid discount for ${line.order_line_id}`
  );
}
const returnedByLine = new Map();
for (const ret of returns) {
  const line = lineById.get(ret.order_line_id);
  assert(line, `return links to line ${ret.order_line_id}`);
  assert.notEqual(
    orderById.get(line.order_id).status,
    'cancelled',
    `no return on cancelled order ${line.order_id}`
  );
  const returned = (returnedByLine.get(ret.order_line_id) || 0) + Number(ret.quantity);
  assert(
    returned <= Number(line.quantity),
    `returned units do not exceed sold units for ${ret.order_line_id}`
  );
  returnedByLine.set(ret.order_line_id, returned);
  const discountedTotal =
    Number(line.unit_price) * Number(line.quantity) - Number(line.discount_amount);
  const maxRefund = (discountedTotal * returned) / Number(line.quantity);
  assert(
    Number(ret.refund_amount) <= maxRefund + 0.011,
    `refund respects discounted sold value for ${ret.return_id}`
  );
}
const expectedSnapshots = products.length * locations.length * 61;
assert.equal(inventory.length, expectedSnapshots, 'one snapshot per product/location/day');
const inventoryKey = new Set();
for (const row of inventory) {
  assert(productIds.has(row.product_id), `inventory product exists: ${row.product_id}`);
  assert(locationIds.has(row.location_id), `inventory location exists: ${row.location_id}`);
  assert(
    Number(row.available_units) >= 0,
    `nonnegative stock: ${row.product_id}/${row.location_id}/${row.snapshot_date}`
  );
  const key = `${row.snapshot_date}|${row.product_id}|${row.location_id}`;
  assert(!inventoryKey.has(key), `unique inventory key ${key}`);
  inventoryKey.add(key);
}
const openingStock = new Map(
  inventory.map((row) => [
    `${row.snapshot_date}|${row.product_id}|${row.location_id}`,
    Number(row.available_units),
  ])
);
const soldByDayLocationProduct = new Map();
for (const line of lines) {
  const order = orderById.get(line.order_id);
  if (order.status !== 'completed') continue;
  const date = order.ordered_at.slice(0, 10);
  const key = `${date}|${line.product_id}|${order.location_id}`;
  soldByDayLocationProduct.set(
    key,
    (soldByDayLocationProduct.get(key) || 0) + Number(line.quantity)
  );
}
for (const [key, units] of soldByDayLocationProduct) {
  assert(openingStock.has(key), `opening snapshot exists for sales ${key}`);
  assert(units <= openingStock.get(key), `completed units sold do not exceed opening stock ${key}`);
}
const productNetSales = new Map();
for (const line of lines) {
  if (orderById.get(line.order_id).status !== 'completed') continue;
  const lineSales = Number(line.quantity) * Number(line.unit_price) - Number(line.discount_amount);
  const lineRefunds = returns
    .filter((ret) => ret.order_line_id === line.order_line_id)
    .reduce((sum, ret) => sum + Number(ret.refund_amount), 0);
  productNetSales.set(
    line.product_id,
    (productNetSales.get(line.product_id) || 0) + lineSales - lineRefunds
  );
}
const availability = new Map();
for (const row of inventory) {
  const key = `${row.product_id}|${row.snapshot_date}`;
  availability.set(key, (availability.get(key) || 0) + Number(row.available_units));
}
const stockDays = new Map();
for (const [key, units] of availability) {
  const productId = key.split('|')[0];
  stockDays.set(productId, (stockDays.get(productId) || 0) + (units > 0 ? 1 : 0));
}
const velocity = (productId) => productNetSales.get(productId) / stockDays.get(productId);
assert(
  stockDays.get('stl-012') < 50,
  'Harbor Storage Bench has material stockout days across all locations'
);
assert(
  velocity('stl-012') > velocity('chr-003'),
  'constrained bench has higher in-stock-day sales than the healthy chair comparison'
);
for (const review of reviews)
  assert(productIds.has(review.product_id), `review product exists: ${review.review_id}`);
for (const ticket of tickets) {
  const order = orderById.get(ticket.order_id);
  assert(order, `support order exists: ${ticket.ticket_id}`);
  assert(
    Date.parse(ticket.created_at) > Date.parse(order.ordered_at),
    `support case follows its order: ${ticket.ticket_id}`
  );
  if (ticket.order_line_id) {
    const line = lineById.get(ticket.order_line_id);
    assert(
      line && line.order_id === ticket.order_id,
      `support line belongs to order: ${ticket.ticket_id}`
    );
  }
}
const ambiguous = tickets.filter(
  (ticket) =>
    !ticket.order_line_id &&
    new Set(
      lines.filter((line) => line.order_id === ticket.order_id).map((line) => line.product_id)
    ).size > 1
);
assert(
  ambiguous.length >= 8,
  'ambiguous support cases retain multi-product orders without line keys'
);
assert.equal(
  tickets.filter((ticket) => ticket.status === 'awaiting_customer').length,
  ambiguous.length,
  'unresolved item requests await the customer'
);
for (const dataset of [reviews, tickets]) {
  const pageSize = 17;
  const idsOnPages = [];
  for (let offset = 0; offset < dataset.length; offset += pageSize)
    idsOnPages.push(
      ...dataset.slice(offset, offset + pageSize).map((row) => row.review_id ?? row.ticket_id)
    );
  assert.equal(idsOnPages.length, dataset.length, 'pagination visits every record');
  assert.equal(new Set(idsOnPages).size, dataset.length, 'pagination has no duplicate keys');
}
for (const name of [
  'products.csv',
  'sales_orders.csv',
  'sales_order_lines.csv',
  'returns.csv',
  'inventory_daily.csv',
]) {
  const raw = await readFile(resolve(root, 'data/retail', name), 'utf8');
  assert(
    !/issue_category|resolution_type|target_classification|expected_outcome/i.test(raw),
    `${name} contains no answer labels`
  );
}
process.stderr.write(
  `Valid: ${products.length} products, ${orders.length} orders, ${lines.length} lines, ${returns.length} returns, ${inventory.length} snapshots, ${reviews.length} reviews, ${tickets.length} tickets (${ambiguous.length} intentionally ambiguous).\n`
);
