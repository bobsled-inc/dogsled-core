import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { SyntaxBlock } from '@/components/ui/syntax-block';
import { getShopFileTree, isShopDemoReady, readShopReadme } from '@/lib/shop-demo-workspace';

export const dynamic = 'force-dynamic';

const FEATURES = [
  [
    'Seeds',
    'Five committed CSVs load raw customers, products, orders, line items, and payments into DuckDB with replace-on-conflict resets.',
  ],
  [
    'Cleaning',
    'Staging models use Model Spec expressions — collapse_whitespace, strip_legal_suffixes, digits_only, strip_www — to normalize messy raw data in SQL.',
  ],
  [
    'Contracts',
    'Expectation blocks enforce primary keys, non-null constraints, regex patterns, accepted value sets, and minimum row counts.',
  ],
  [
    'Metadata',
    'Every column carries a semantic_role (entity_id, email, currency…), PII flags, format hints, unit labels, and embedding_candidate markers.',
  ],
  [
    'Marts',
    'fct_orders joins staging tables into an order fact. dim_customers rolls up lifetime revenue and order counts per customer.',
  ],
  [
    'Semantics',
    'Three metrics, two relationships, and two verified queries make the project queryable by agents and BI tools without writing ad-hoc SQL.',
  ],
] as const;

const STEPS = [
  {
    step: '1',
    title: 'Build the database',
    description: 'Run the rebuild script to seed raw CSVs into DuckDB and materialise all models.',
    code: 'pnpm exec tsx rebuild-demo.ts',
    href: null,
  },
  {
    step: '2',
    title: 'Browse the data',
    description:
      'Inspect every table — raw sources, cleaned staging views, and mart tables — row by row.',
    code: null,
    href: '/demo/shop/data',
  },
  {
    step: '3',
    title: 'Read the models',
    description:
      'See the Model Spec YAML side-by-side with the SQL it compiles to for DuckDB. Start with stg_customers for the cleaning layer.',
    code: null,
    href: '/demo/shop/models',
  },
  {
    step: '4',
    title: 'Check the metrics',
    description:
      'Three semantic metric definitions — order count, average order value, total revenue — with live values computed from the DB.',
    code: null,
    href: '/demo/shop/metrics',
  },
  {
    step: '5',
    title: 'Run verified queries',
    description:
      'Pre-approved SQL that agents can execute reliably: revenue by month and top customers by spend.',
    code: null,
    href: '/demo/shop/queries',
  },
  {
    step: '6',
    title: 'Validate and compile',
    description:
      'Run the Model Spec CLI to validate contracts and compile any model to inspect the generated SQL.',
    code: 'dogsled model validate --integration duckdb\ndogsled model compile stg_customers --integration duckdb',
    href: null,
  },
] as const;

export default async function ShopDemoOverviewPage() {
  const [readme, tree] = await Promise.all([readShopReadme(), getShopFileTree()]);
  const ready = isShopDemoReady();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Dogsled', href: '/' }, { label: 'Demo' }, { label: 'Shop Demo' }]}
        title="Shop Demo"
        description="A complete Model Spec reference project: five raw CSVs become cleaned staging views, mart tables, metrics, and verified queries — all in local DuckDB."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/demo/shop/data"
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            >
              Browse Data
            </Link>
            <Link
              href="/demo/shop/models"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Inspect Models
            </Link>
          </div>
        }
      />

      {/* Feature grid */}
      <section className="grid gap-3 md:grid-cols-3">
        {FEATURES.map(([title, description]) => (
          <div key={title} className="rounded-lg border border-border bg-card p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {title}
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        ))}
      </section>

      {/* Setup notice */}
      {!ready && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
          The DuckDB file has not been built yet. Run{' '}
          <code className="rounded bg-amber-500/20 px-1 font-mono">
            pnpm exec tsx rebuild-demo.ts
          </code>{' '}
          from <code className="rounded bg-amber-500/20 px-1 font-mono">workspace/shop-demo</code>{' '}
          to seed the data and materialise all models.
        </div>
      )}

      {/* Step-by-step walkthrough */}
      <section>
        <h2 className="mb-4 text-sm font-semibold">How to walk through this demo</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map(({ step, title, description, code, href }) => (
            <div
              key={step}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                  {step}
                </span>
                <span className="text-sm font-medium">{title}</span>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">{description}</p>
              {code && <SyntaxBlock code={code} language="bash" className="max-h-24 text-[11px]" />}
              {href && (
                <Link
                  href={href}
                  className="mt-auto inline-flex items-center text-xs text-primary hover:underline"
                >
                  Open →
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Narrative + file tree */}
      <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">About the dataset</h2>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
            {readme
              .replace(/^# Shop Demo\s*/m, '')
              .replace(/## Run It[\s\S]*/, '')
              .trim()}
          </p>
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold">Project files</h2>
          <SyntaxBlock code={tree.join('\n')} language="plaintext" className="max-h-[430px]" />
        </div>
      </section>
    </div>
  );
}
