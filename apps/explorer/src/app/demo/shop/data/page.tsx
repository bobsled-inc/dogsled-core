import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { isShopDemoReady, runShopSql } from '@/lib/shop-demo-workspace';

export const dynamic = 'force-dynamic';

const TABLE_LAYERS: { label: string; tables: string[] }[] = [
  {
    label: 'Sources',
    tables: [
      'raw.raw_customers',
      'raw.raw_products',
      'raw.raw_orders',
      'raw.raw_order_items',
      'raw.raw_payments',
    ],
  },
  {
    label: 'Staging',
    tables: ['stg_customers', 'stg_products', 'stg_orders', 'stg_order_items', 'stg_payments'],
  },
  { label: 'Marts', tables: ['fct_orders', 'dim_customers'] },
];

const FALLBACK_TABLES = TABLE_LAYERS.flatMap((l) => l.tables);

function safeTableName(value: string | undefined): string {
  return FALLBACK_TABLES.includes(value ?? '') ? value! : 'fct_orders';
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number')
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const s = String(value);
  if (ISO_DATE_RE.test(s)) return s.slice(0, 10);
  return s;
}

export default async function ShopDemoDataPage({
  searchParams,
}: {
  searchParams?: Promise<{ table?: string }>;
}) {
  const params = await searchParams;
  const ready = isShopDemoReady();
  const selected = safeTableName(params?.table);
  const rows = ready ? await runShopSql(`SELECT * FROM ${selected} LIMIT 50`) : [];
  const columns = rows[0] ? Object.keys(rows[0]) : [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Dogsled', href: '/' },
          { label: 'Demo', href: '/demo/shop' },
          { label: 'Data' },
        ]}
        title="Shop Data"
        description="A compact browser for the demo DuckDB tables produced by the seed and model run."
      />

      {!ready ? (
        <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
          Build <code className="font-mono">workspace/shop-demo/demo.db</code> with{' '}
          <code className="font-mono">pnpm exec tsx rebuild-demo.ts</code> before browsing rows.
        </div>
      ) : (
        <section className="grid gap-4 lg:grid-cols-[240px_1fr]">
          <nav className="flex flex-col gap-3 rounded-lg border border-border bg-card p-2">
            {TABLE_LAYERS.map((layer) => (
              <div key={layer.label}>
                <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {layer.label}
                </div>
                {layer.tables.map((table) => (
                  <Link
                    key={table}
                    href={`/demo/shop/data?table=${encodeURIComponent(table)}`}
                    className={`block rounded-md px-3 py-2 text-xs ${
                      table === selected
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {table}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3 text-sm font-semibold">{selected}</div>
            <div className="overflow-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    {columns.map((column) => (
                      <th key={column} className="px-3 py-2 font-medium">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index} className="border-t border-border">
                      {columns.map((column) => (
                        <td key={column} className="px-3 py-2 text-muted-foreground">
                          {formatValue(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
