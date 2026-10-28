import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SyntaxBlock } from '@/components/ui/syntax-block';
import {
  isShopDemoReady,
  listShopVqFiles,
  readShopVqYaml,
  resolveVqSql,
  runShopSql,
} from '@/lib/shop-demo-workspace';
import yaml from 'yaml';

export const dynamic = 'force-dynamic';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number')
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const s = String(value);
  if (ISO_DATE_RE.test(s)) return s.slice(0, 7); // "2026-01" for month-truncated dates
  return s;
}

interface VqResult {
  name: string;
  nlq: string;
  yamlSource: string;
  sql: string;
  rows: Record<string, unknown>[];
  columns: string[];
  error: string | null;
}

export default async function ShopDemoQueriesPage() {
  const ready = isShopDemoReady();
  const files = await listShopVqFiles();

  const vqs: VqResult[] = await Promise.all(
    files.map(async (file) => {
      const yamlSource = await readShopVqYaml(file);
      const parsed = yaml.parse(yamlSource) as { name: string; nlq: string; sql: string };
      const resolvedSql = resolveVqSql(parsed.sql.trim());
      let rows: Record<string, unknown>[] = [];
      let error: string | null = null;
      if (ready) {
        try {
          rows = await runShopSql(resolvedSql);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      return {
        name: parsed.name,
        nlq: parsed.nlq,
        yamlSource,
        sql: resolvedSql,
        rows,
        columns: rows[0] ? Object.keys(rows[0]) : [],
        error,
      };
    })
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <PageHeader
        breadcrumbs={[
          { label: 'Dogsled', href: '/' },
          { label: 'Demo', href: '/demo/shop' },
          { label: 'Queries' },
        ]}
        title="Verified Queries"
        description="Pre-approved SQL queries attached to the project so agents and BI tools can answer common questions reliably."
      />

      {!ready && (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          Build the demo database to see live query results.{' '}
          <Link href="/demo/shop" className="underline underline-offset-2">
            See the overview
          </Link>{' '}
          for instructions.
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4 text-xs">
        <p className="mb-2 font-semibold">How agents use verified queries</p>
        <p className="mb-3 text-muted-foreground">
          When an agent receives a natural-language question, MODEL_SPEC matches it against the{' '}
          <code className="font-mono">nlq</code> field of each VQ. A match returns the pre-approved
          SQL rather than generating ad-hoc SQL — making answers reproducible and auditable. Model
          references in curly braces are resolved to the actual table name at query time.
        </p>
        <SyntaxBlock
          code={`# Run a verified query directly\ndogsled model query revenue_by_month --integration duckdb`}
          language="bash"
        />
      </div>

      <div className="grid gap-6">
        {vqs.map((vq) => (
          <div key={vq.name} className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <div className="font-semibold">{vq.name}</div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                <span className="mr-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
                  NLQ
                </span>
                {vq.nlq}
              </p>
            </div>

            <div className="grid gap-4 p-4 xl:grid-cols-2">
              <div>
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  YAML spec
                </div>
                <SyntaxBlock code={vq.yamlSource} language="yaml" className="max-h-64" />
              </div>

              <div>
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {ready ? 'Result' : 'SQL'}
                </div>
                {vq.error ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                    {vq.error}
                  </div>
                ) : !ready || vq.columns.length === 0 ? (
                  <SyntaxBlock code={vq.sql} language="sql" className="max-h-64" />
                ) : (
                  <div className="overflow-hidden rounded-md border border-border">
                    <div className="overflow-auto max-h-64">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-muted/50 text-muted-foreground">
                          <tr>
                            {vq.columns.map((col) => (
                              <th key={col} className="px-3 py-2 font-medium">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {vq.rows.map((row, i) => (
                            <tr key={i} className="border-t border-border">
                              {vq.columns.map((col) => (
                                <td key={col} className="px-3 py-2 text-muted-foreground">
                                  {formatValue(row[col])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
