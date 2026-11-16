import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const seed = 20261029;
let state = seed;
function random() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
}
function int(min, max) {
  return min + Math.floor(random() * (max - min + 1));
}
function pick(values) {
  return values[Math.floor(random() * values.length)];
}
function csv(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function writeCsv(name, rows, columns) {
  const body =
    [columns.join(','), ...rows.map((row) => columns.map((key) => csv(row[key])).join(','))].join(
      '\n'
    ) + '\n';
  await writeFile(resolve(root, 'data/retail', name), body);
}

const suppliers = [
  {
    supplier_id: 'sup-101',
    supplier_name: 'Northstar Lighting Works',
    country: 'US',
    lead_time_days: 12,
  },
  {
    supplier_id: 'sup-102',
    supplier_name: 'Juniper Housewares Co.',
    country: 'US',
    lead_time_days: 9,
  },
  {
    supplier_id: 'sup-103',
    supplier_name: 'Cedar & Loom Furnishings',
    country: 'CA',
    lead_time_days: 18,
  },
  {
    supplier_id: 'sup-104',
    supplier_name: 'Brightline Imports',
    country: 'MX',
    lead_time_days: 21,
  },
];
const products = [
  ['lmp-009', 'Arc Task Lamp', 'Lighting', 'sup-101', 89.0, 34.0],
  ['stl-012', 'Harbor Storage Bench', 'Furniture', 'sup-103', 349.0, 172.0],
  ['chr-003', 'Morrow Dining Chair', 'Furniture', 'sup-103', 179.0, 82.0],
  ['kit-018', 'Stoneware Prep Bowl Set', 'Kitchenware', 'sup-102', 42.0, 14.5],
  ['lmp-002', 'Globe Pendant Light', 'Lighting', 'sup-104', 219.0, 101.0],
  ['tbl-014', 'Elm Side Table', 'Furniture', 'sup-103', 159.0, 68.0],
  ['kit-006', 'Ridge Cast-Iron Skillet', 'Kitchenware', 'sup-102', 74.0, 31.0],
  ['lmp-021', 'Paper Shade Floor Lamp', 'Lighting', 'sup-101', 139.0, 55.0],
  ['chr-016', 'Wren Counter Stool', 'Furniture', 'sup-103', 149.0, 69.0],
  ['kit-011', 'Everyday Linen Apron', 'Kitchenware', 'sup-102', 38.0, 12.0],
  ['tbl-005', 'Round Oak Coffee Table', 'Furniture', 'sup-103', 329.0, 171.0],
  ['kit-020', 'Mason Glass Storage Set', 'Kitchenware', 'sup-102', 56.0, 19.0],
  ['lmp-015', 'Silo Desk Lamp', 'Lighting', 'sup-101', 119.0, 46.0],
  ['chr-008', 'Alder Lounge Chair', 'Furniture', 'sup-103', 499.0, 258.0],
  ['kit-004', 'Speckled Mug Pair', 'Kitchenware', 'sup-102', 28.0, 8.0],
  ['tbl-019', 'Nesting Tray Tables', 'Furniture', 'sup-104', 189.0, 79.0],
  ['lmp-006', 'Opal Globe Sconce', 'Lighting', 'sup-101', 99.0, 37.0],
  ['kit-023', 'Maple Cutting Board', 'Kitchenware', 'sup-102', 64.0, 22.0],
  ['chr-011', 'Sutton Upholstered Bench', 'Furniture', 'sup-103', 389.0, 195.0],
  ['kit-009', 'Pour-Over Coffee Set', 'Kitchenware', 'sup-102', 52.0, 18.0],
  ['lmp-024', 'Brass Reading Light', 'Lighting', 'sup-104', 159.0, 61.0],
  ['tbl-002', 'Narrow Entry Console', 'Furniture', 'sup-103', 279.0, 139.0],
  ['kit-015', 'Cotton Tea Towel Trio', 'Kitchenware', 'sup-102', 32.0, 10.0],
  ['chr-022', 'Stackable Bistro Chair', 'Furniture', 'sup-104', 129.0, 54.0],
].map(([product_id, product_name, category, supplier_id, list_price, unit_cost]) => ({
  product_id,
  product_name,
  category,
  supplier_id,
  list_price: list_price.toFixed(2),
  unit_cost: unit_cost.toFixed(2),
  active_from: '2025-01-01',
  active: true,
}));
const locations = [
  { location_id: 'WEB', location_name: 'Online Fulfillment', location_type: 'web' },
  { location_id: 'ST-SEA', location_name: 'Seattle Store', location_type: 'store' },
  { location_id: 'ST-PDX', location_name: 'Portland Store', location_type: 'store' },
  { location_id: 'ST-AUS', location_name: 'Austin Store', location_type: 'store' },
];
const start = new Date('2026-08-16T00:00:00Z');
const days = Array.from({ length: 61 }, (_, i) =>
  new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10)
);
const inventory = [];
const orders = [];
const lines = [];
const returns = [];
const stock = new Map();
const productById = new Map(products.map((p) => [p.product_id, p]));
const endStock = new Map();
for (const p of products)
  for (const location of locations) {
    const key = `${p.product_id}|${location.location_id}`;
    const constrained = p.product_id === 'stl-012';
    stock.set(key, constrained ? int(2, 4) : int(14, 28));
  }

let orderNumber = 1;
let lineNumber = 1;
const orderLineIndex = new Map();
const demandWeights = products.map((p) =>
  p.product_id === 'lmp-009'
    ? 7
    : p.product_id === 'stl-012'
      ? 25
      : p.product_id === 'chr-003'
        ? 4
        : 1
);
for (const day of days) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const dailyOrders = int(8, 12) + (weekday === 0 || weekday === 6 ? 3 : 0);
  for (const location of locations)
    for (const p of products) {
      const key = `${p.product_id}|${location.location_id}`;
      let available = stock.get(key);
      const interval = p.product_id === 'stl-012' ? 17 : 10;
      if (days.indexOf(day) > 0 && days.indexOf(day) % interval === 0) {
        available = p.product_id === 'stl-012' ? int(2, 3) : int(16, 30);
      }
      inventory.push({
        snapshot_date: day,
        product_id: p.product_id,
        location_id: location.location_id,
        available_units: available,
      });
      stock.set(key, available);
    }
  for (let n = 0; n < dailyOrders; n++) {
    const location = pick(locations);
    const eligible = products.filter(
      (p) => stock.get(`${p.product_id}|${location.location_id}`) > 0
    );
    const weighted = eligible.flatMap((p) => Array(demandWeights[products.indexOf(p)]).fill(p));
    if (!weighted.length) continue;
    const p = pick(weighted);
    const key = `${p.product_id}|${location.location_id}`;
    const quantity = Math.min(
      stock.get(key),
      int(p.product_id === 'lmp-009' ? 1 : 1, p.product_id === 'stl-012' ? 2 : 3)
    );
    const id = `ORD-${String(orderNumber).padStart(5, '0')}`;
    const status = random() < 0.035 ? 'cancelled' : 'completed';
    const lineId = `LINE-${String(lineNumber++).padStart(6, '0')}`;
    const unitPrice = Number(p.list_price);
    const discount = random() < 0.13 ? Number((unitPrice * quantity * 0.1).toFixed(2)) : 0;
    const line = {
      order_line_id: lineId,
      order_id: id,
      product_id: p.product_id,
      quantity,
      unit_price: unitPrice.toFixed(2),
      discount_amount: discount.toFixed(2),
    };
    lines.push(line);
    orderLineIndex.set(lineId, { ...line, day, status, location_id: location.location_id });
    const lineIds = [lineId];
    if (random() < 0.16) {
      const second = products.filter(
        (x) =>
          x.product_id !== p.product_id && stock.get(`${x.product_id}|${location.location_id}`) > 0
      );
      if (second.length) {
        const p2 = pick(second);
        const k2 = `${p2.product_id}|${location.location_id}`;
        const id2 = `LINE-${String(lineNumber++).padStart(6, '0')}`;
        const qty2 = Math.min(stock.get(k2), 1);
        const discount2 =
          random() < 0.13 ? Number((Number(p2.list_price) * qty2 * 0.1).toFixed(2)) : 0;
        const line2 = {
          order_line_id: id2,
          order_id: id,
          product_id: p2.product_id,
          quantity: qty2,
          unit_price: p2.list_price,
          discount_amount: discount2.toFixed(2),
        };
        lines.push(line2);
        lineIds.push(id2);
        orderLineIndex.set(id2, { ...line2, day, status, location_id: location.location_id });
        if (status !== 'cancelled') stock.set(k2, stock.get(k2) - qty2);
      }
    }
    orders.push({
      order_id: id,
      ordered_at: `${day}T${String(int(8, 21)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00Z`,
      status,
      channel: location.location_id === 'WEB' ? 'online' : 'store',
      location_id: location.location_id,
      customer_id: `CUS-${String(int(1, 420)).padStart(4, '0')}`,
    });
    orderLineIndex.set(`ORDERLINES:${id}`, lineIds);
    if (status !== 'cancelled') stock.set(key, stock.get(key) - quantity);
    orderNumber++;
  }
}
// Return records are separate cash events and stay linked to the original line.
for (const line of lines) {
  const order = orderLineIndex.get(line.order_line_id);
  if (order.status === 'cancelled') continue;
  const baseRate =
    line.product_id === 'lmp-009'
      ? 0.48
      : line.product_id === 'stl-012'
        ? 0.06
        : line.product_id === 'chr-003'
          ? 0.035
          : 0.045;
  if (random() >= baseRate) continue;
  const qty = int(1, line.quantity);
  const reason =
    line.product_id === 'lmp-009'
      ? pick(['arrived damaged', 'cracked shade on arrival', 'damaged in transit'])
      : pick(['changed my mind', 'size was not right', 'arrived later than expected']);
  const returnDate = new Date(`${order.day}T00:00:00Z`);
  returnDate.setUTCDate(returnDate.getUTCDate() + int(2, 15));
  if (returnDate.toISOString().slice(0, 10) > '2026-10-15') continue;
  const netLine = Number(line.unit_price) * line.quantity - Number(line.discount_amount);
  returns.push({
    return_id: `RET-${String(returns.length + 1).padStart(5, '0')}`,
    order_line_id: line.order_line_id,
    returned_at: `${returnDate.toISOString().slice(0, 10)}T15:00:00Z`,
    quantity: qty,
    refund_amount: ((netLine * qty) / line.quantity).toFixed(2),
    reason,
  });
}

const reviewQuotes = {
  'lmp-009': [
    'The glass shade arrived in pieces. Support sent a replacement quickly.',
    'Beautiful light, but the shade was cracked when I opened the box.',
    'Love the warm light. Packaging could protect the glass better.',
  ],
  'stl-012': [
    'We wanted the bench in both bedrooms but it was out of stock again.',
    'Great storage and sturdy build. I would buy a second one if it were available.',
    'I signed up for a restock email after seeing it sell out.',
  ],
  'chr-003': [
    'Comfortable chair and the finish matches the table.',
    'Easy to assemble and feels solid after a month.',
    'Good everyday chair for our kitchen.',
  ],
  default: [
    'Looks good in our home and works as expected.',
    'Nice quality for the price.',
    'The item arrived on time and matched the photos.',
  ],
};
const reviews = Array.from({ length: 96 }, (_, i) => {
  const p =
    i < 21
      ? productById.get('lmp-009')
      : i < 37
        ? productById.get('stl-012')
        : i < 51
          ? productById.get('chr-003')
          : pick(products);
  const quote = pick(reviewQuotes[p.product_id] ?? reviewQuotes.default);
  const rating =
    p.product_id === 'lmp-009'
      ? quote.includes('pieces') || quote.includes('cracked')
        ? 1
        : 4
      : p.product_id === 'stl-012'
        ? quote.includes('out of stock') || quote.includes('sell out')
          ? 4
          : 5
        : p.product_id === 'chr-003'
          ? 5
          : int(3, 5);
  return {
    review_id: `REV-${String(i + 1).padStart(4, '0')}`,
    product_id: p.product_id,
    rating,
    review_text: quote,
    reviewed_at: `${days[int(4, 59)]}T12:00:00Z`,
    verified_purchase: random() < 0.91,
  };
});

const supportTemplates = [
  ['The glass shade arrived cracked and there are small pieces in the carton.', 'arrived damaged'],
  ['My Arc Task Lamp turns on but the shade is broken from shipping.', 'arrived damaged'],
  [
    'The bench is sold out at the website and the Seattle store. Can I get a restock date?',
    'availability',
  ],
  [
    'I ordered a second bench for the guest room but it has been unavailable for weeks.',
    'availability',
  ],
  [
    'The dining chair was easy to assemble and looks great. Just sharing feedback.',
    'positive feedback',
  ],
  [
    'Can you help me with my recent purchase? One of the items is not right, but I am not sure which line item the photo shows.',
    'ambiguous',
  ],
];
const supportTickets = [];
for (let i = 0; i < 40; i++) {
  const template =
    i < 12
      ? supportTemplates[i % 2]
      : i < 21
        ? supportTemplates[2 + (i % 2)]
        : i < 30
          ? supportTemplates[4]
          : supportTemplates[5];
  const kind = template[1];
  const explicitProduct =
    kind === 'arrived damaged'
      ? 'lmp-009'
      : kind === 'availability'
        ? 'stl-012'
        : kind === 'positive feedback'
          ? 'chr-003'
          : null;
  const matchingOrders = orders.filter((o) => {
    if (o.status !== 'completed') return false;
    const ids = orderLineIndex.get(`ORDERLINES:${o.order_id}`);
    if (kind === 'ambiguous') return ids.length > 1;
    return ids.some((id) => orderLineIndex.get(id).product_id === explicitProduct);
  });
  const order = pick(matchingOrders);
  let orderLines = orderLineIndex
    .get(`ORDERLINES:${order.order_id}`)
    .map((id) => orderLineIndex.get(id));
  if (explicitProduct)
    orderLines = orderLines.filter((line) => line.product_id === explicitProduct);
  const orderLine = kind === 'ambiguous' ? null : pick(orderLines);
  const ticketDate = new Date(`${order.ordered_at.slice(0, 10)}T00:00:00Z`);
  ticketDate.setUTCDate(ticketDate.getUTCDate() + int(1, 9));
  supportTickets.push({
    ticket_id: `case-${String(i + 1).padStart(4, '0')}`,
    created_at: `${ticketDate.toISOString().slice(0, 10)}T${String(int(8, 20)).padStart(2, '0')}:30:00Z`,
    order_id: order.order_id,
    customer_id: order.customer_id,
    subject:
      template[1] === 'availability'
        ? 'Product availability question'
        : template[1] === 'arrived damaged'
          ? 'Item damaged on arrival'
          : 'Question about recent purchase',
    message: template[0],
    agent_reply:
      template[1] === 'availability'
        ? 'We have added a restock alert and will email when units are available.'
        : template[1] === 'arrived damaged'
          ? 'We are sorry about the damage. A replacement shade is on the way at no charge.'
          : template[1] === 'positive feedback'
            ? 'Thanks for taking the time to share your feedback.'
            : 'Please reply with the item name or a photo so we can identify the product.',
    status: kind === 'ambiguous' ? 'awaiting_customer' : 'resolved',
    ...(orderLine ? { order_line_id: orderLine.order_line_id } : {}),
  });
}

await mkdir(resolve(root, 'data/retail'), { recursive: true });
await writeCsv('suppliers.csv', suppliers, [
  'supplier_id',
  'supplier_name',
  'country',
  'lead_time_days',
]);
await writeCsv('products.csv', products, [
  'product_id',
  'product_name',
  'category',
  'supplier_id',
  'list_price',
  'unit_cost',
  'active_from',
  'active',
]);
await writeCsv('locations.csv', locations, ['location_id', 'location_name', 'location_type']);
await writeCsv('sales_orders.csv', orders, [
  'order_id',
  'ordered_at',
  'status',
  'channel',
  'location_id',
  'customer_id',
]);
await writeCsv('sales_order_lines.csv', lines, [
  'order_line_id',
  'order_id',
  'product_id',
  'quantity',
  'unit_price',
  'discount_amount',
]);
await writeCsv('returns.csv', returns, [
  'return_id',
  'order_line_id',
  'returned_at',
  'quantity',
  'refund_amount',
  'reason',
]);
await writeCsv('inventory_daily.csv', inventory, [
  'snapshot_date',
  'product_id',
  'location_id',
  'available_units',
]);
await mkdir(resolve(root, 'data/retail/api'), { recursive: true });
await writeFile(
  resolve(root, 'data/retail/api/reviews.json'),
  JSON.stringify(reviews, null, 2) + '\n'
);
await writeFile(
  resolve(root, 'data/retail/api/support-tickets.json'),
  JSON.stringify(supportTickets, null, 2) + '\n'
);
process.stderr.write(
  `Generated ${products.length} products, ${orders.length} orders, ${lines.length} lines, ${returns.length} returns, ${inventory.length} inventory snapshots, ${reviews.length} reviews and ${supportTickets.length} support tickets (seed ${seed}).\n`
);
