import { readFileSync } from 'node:fs';
export function showcaseData(name) {
  if (name === 'semantic-layer-vq') {
    const datasets = Object.fromEntries(
      ['orders', 'customers', 'products', 'categories'].map((table) => {
        const lines = readFileSync(
          new URL(`../../examples/models-full/seeds/data/${table}.csv`, import.meta.url),
          'utf8'
        )
          .trim()
          .split('\n');
        const columns = lines.shift().split(',');
        return [
          table,
          lines.map((line) =>
            Object.fromEntries(
              line
                .split(',')
                .map((value, index) => [
                  columns[index],
                  /^\d+$/.test(value) ? Number(value) : value,
                ])
            )
          ),
        ];
      })
    );
    return {
      datasets,
      advance() {
        throw new Error('Only incremental-cursors supports advance');
      },
    };
  }
  const rows = (count, prefix) =>
    Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `${prefix}-${i + 1}` }));
  const datasets =
    name === 'mock-api-pipeline'
      ? {
          products: rows(20, 'product'),
          orders: rows(500, 'order'),
          customers: rows(30, 'customer'),
        }
      : name === 'incremental-cursors'
        ? { events: rows(100, 'event') }
        : name === 'fan-out'
          ? { customers: rows(200, 'customer') }
          : name === 'postgres-pipeline'
            ? {
                staff: Array.from({ length: 200 }, (_, i) => ({
                  id: i + 1,
                  department_id: (i % 10) + 1,
                  salary: 50000 + i * 100,
                })),
                departments: rows(10, 'department'),
              }
            : name === 'secret-redaction'
              ? { events: [{ id: 1, name: 'fictional-event' }] }
              : undefined;
  if (!datasets) throw new Error(`Unknown mock dataset: ${name}`);
  return {
    datasets,
    advance() {
      if (name !== 'incremental-cursors' || datasets.events.length !== 100)
        throw new Error('Advance is only valid once for incremental-cursors');
      datasets.events.push(
        ...Array.from({ length: 50 }, (_, i) => ({ id: i + 101, name: `event-${i + 101}` }))
      );
    },
  };
}
