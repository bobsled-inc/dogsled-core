import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { CopyButton } from './copy-button';

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-base font-bold mt-8 mb-3 border-b border-border pb-2">{title}</h2>
      {children}
    </section>
  );
}

function SubSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="mt-5 scroll-mt-24">
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      {children}
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground leading-relaxed mb-2">{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="text-[11px] bg-secondary px-1.5 py-0.5 rounded font-mono">{children}</code>
  );
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="relative mb-3 group">
      {label ? (
        <div className="text-[10px] text-muted-foreground bg-secondary/80 border border-border border-b-0 rounded-t-lg px-3 py-1">
          {label}
        </div>
      ) : null}
      <pre
        className={`bg-card border border-border ${label ? 'rounded-b-lg rounded-tl-none' : 'rounded-lg'} p-3 text-[11px] font-mono overflow-auto whitespace-pre-wrap`}
      >
        {code}
      </pre>
      <CopyButton code={code} />
    </div>
  );
}

const TOC = [
  { id: 'overview', label: 'Overview' },
  { id: 'project-config', label: 'Project Config' },
  { id: 'spec-format', label: 'Spec Format' },
  { id: 'materializations', label: 'Materializations' },
  { id: 'expressions', label: 'Expressions & Joins' },
  { id: 'dialect-support', label: 'Dialect Support' },
  { id: 'data-tests', label: 'Data Tests' },
  { id: 'cli-reference', label: 'CLI Reference' },
];

export default function BobsledModelingPage() {
  return (
    <div className="mx-auto flex max-w-6xl gap-8 p-6">
      <div className="min-w-0 flex-1">
        <PageHeader
          breadcrumbs={[{ label: 'Bobsled Core', href: '/' }, { label: 'Modeling' }]}
          title="Modeling"
          description="YAML-driven data modeling for any warehouse. Define sources, models, joins, and tests in declarative specs — the compiler handles dialect-correct SQL."
          actions={
            <Link
              href="/models"
              className="rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
            >
              Browse model bundles →
            </Link>
          }
        />

        <Section id="overview" title="Overview">
          <P>
            Modeling (Model Spec) is a declarative data modeling layer. YAML specs define sources
            (warehouse tables), models (transformations), joins, materializations, and data tests.
            The compiler builds a dependency DAG, topologically sorts it, and emits dialect-correct
            DDL.
          </P>
          <CodeBlock
            code={`YAML specs → parser → DAG resolver → codegen → CREATE VIEW/TABLE/MERGE SQL`}
          />
          <P>
            Model Spec ships canonical dialect families for Snowflake, BigQuery, Postgres,
            Databricks, MySQL, and DuckDB, plus Postgres-family targets for <Code>pgvector</Code>{' '}
            and <Code>redshift</Code>. The compiler runs as a standalone library.
          </P>
        </Section>

        <Section id="project-config" title="Project Config (model-spec.yml)">
          <P>
            Drop a <Code>model-spec.yml</Code> at the root of your project to configure directory
            layout.
          </P>
          <CodeBlock
            label="model-spec.yml"
            code={`sources_dir: sources   # default: sources
models_dir: models     # default: models
seeds_dir: seeds       # default: seeds
entity_graph_dir: entity-graph           # default: entity-graph`}
          />
          <P>
            CLI flags always override <Code>model-spec.yml</Code>.
          </P>
        </Section>

        <Section id="spec-format" title="Spec Format">
          <P>
            Both sources and models use <Code>spec_version: &apos;0.2&apos;</Code>.
          </P>

          <SubSection id="spec-source" title="Source — registers an existing warehouse table">
            <CodeBlock
              label="sources/raw_orders.yml"
              code={`spec_version: '0.2'
name: raw_orders
type: source
source_type: warehouse_table
connection: ecom   # namespace used in refs: ecom.raw_orders
table: RAW.RAW_ORDERS
schema:
  columns:
    - name: ID
      type: NUMBER`}
            />
          </SubSection>

          <SubSection id="spec-model" title="Model — defines a transformation">
            <CodeBlock
              label="models/stg_orders.yml"
              code={`spec_version: '0.2'
name: stg_orders
type: model
description: Staging layer for orders
grain: order_id   # unique key; array for composite keys
source:
  ref: ecom.raw_orders   # connection.name for sources; just name for model refs
columns:
  - name: ORDER_ID
    expr: ID
    primary_key: true
  - name: ORDER_DATE
    expr: "DATE_TRUNC('day', ORDERED_AT)"
materialization:
  type: view`}
            />
          </SubSection>

          <SubSection id="ref-syntax" title="Ref Syntax">
            <P>
              Source ref: <Code>connection.source_name</Code> (e.g., <Code>ecom.raw_orders</Code>)
              <br />
              Model ref: just <Code>model_name</Code> (e.g., <Code>stg_orders</Code>)
            </P>
          </SubSection>
        </Section>

        <Section id="materializations" title="Materializations">
          <div className="overflow-x-auto rounded-xl border border-border mb-3">
            <table className="w-full text-xs">
              <thead className="bg-secondary/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-left font-medium">Behavior</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['view', 'CREATE OR REPLACE VIEW'],
                  ['table', 'Full replace on every run'],
                  [
                    'incremental',
                    'MERGE/upsert — requires strategy, unique_key, incremental_filter',
                  ],
                  ['ephemeral', 'Inlined as CTE; no DDL emitted'],
                  ['snapshot', 'SCD Type 2 — requires unique_key, tracked_columns'],
                ].map(([type, behavior]) => (
                  <tr key={type} className="border-t border-border/70">
                    <td className="px-4 py-2 font-mono text-primary">{type}</td>
                    <td className="px-4 py-2 text-muted-foreground">{behavior}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <P>
            Use <Code>self</Code> in <Code>incremental_filter</Code> to reference the model&apos;s
            own table:
          </P>
          <CodeBlock code={`incremental_filter: 'created_at > DATEADD(day, -3, self)'`} />
        </Section>

        <Section id="expressions" title="Expressions &amp; Joins">
          <SubSection id="expressions-detail" title="Column expressions">
            <P>
              Columns support raw SQL in <Code>expr</Code>. Use{' '}
              <Code>coalesce_strategy: first_non_null</Code> with multi-source joins.
            </P>
            <CodeBlock
              code={`columns:
  - name: AMOUNT_USD
    expr: "ROUND(amount / 100.0, 2)"
  - name: STATUS
    expr: UPPER(status)`}
            />
          </SubSection>

          <SubSection id="joins-detail" title="Joins">
            <CodeBlock
              code={`joins:
  - ref: ecom.raw_customers
    type: left
    on: "orders.customer_id = customers.id"
    columns:
      - name: EMAIL
        source_column: email`}
            />
          </SubSection>

          <SubSection id="json-flatten" title="JSON Flatten">
            <P>
              Auto-flatten JSON/VARIANT columns with <Code>json_flatten</Code>:
            </P>
            <CodeBlock
              code={`columns:
  - name: METADATA_PLAN
    json_path: metadata.plan
    json_source: metadata_col`}
            />
          </SubSection>
        </Section>

        <Section id="dialect-support" title="Dialect Support">
          <div className="overflow-x-auto rounded-xl border border-border mb-3">
            <table className="w-full text-xs">
              <thead className="bg-secondary/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Dialect</th>
                  <th className="px-4 py-2 text-left font-medium">Flag</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Snowflake', 'snowflake'],
                  ['BigQuery', 'bigquery'],
                  ['PostgreSQL', 'postgres'],
                  ['DuckDB', 'duckdb'],
                  ['Databricks', 'databricks'],
                  ['MySQL', 'mysql'],
                  ['pgvector', 'pgvector'],
                  ['Redshift', 'redshift'],
                ].map(([name, flag]) => (
                  <tr key={flag} className="border-t border-border/70">
                    <td className="px-4 py-2 font-medium">{name}</td>
                    <td className="px-4 py-2 font-mono text-muted-foreground">--dialect {flag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="data-tests" title="Data Tests">
          <P>
            Add a <Code>tests</Code> block to any model to generate assertion SQL. Tests run via{' '}
            <Code>bobsled model test</Code>.
          </P>
          <CodeBlock
            code={`tests:
  - type: not_null
    column: ORDER_ID
  - type: unique
    column: ORDER_ID
  - type: accepted_values
    column: STATUS
    values: [pending, complete, cancelled]
  - type: relationships
    column: CUSTOMER_ID
    ref: stg_customers
    ref_column: CUSTOMER_ID`}
          />
        </Section>

        <Section id="cli-reference" title="CLI Reference">
          <P>
            Use <Code>bobsled model</Code> for all data modeling operations.{' '}
            <Link href="/terminal" className="text-primary hover:underline">
              Run in Terminal →
            </Link>
          </P>

          <SubSection id="cli-compile" title="Compile">
            <CodeBlock
              code={`bobsled model compile                        # All models to stdout
bobsled model compile stg_orders             # Single model
bobsled model compile -o target/             # Write to files
bobsled model compile --dialect bigquery     # Target dialect
bobsled model compile --strict               # Reject implicit raw_sql fallbacks`}
            />
          </SubSection>

          <SubSection id="cli-run" title="Run">
            <CodeBlock
              code={`bobsled model run --runner ./runner.js       # Compile + execute
bobsled model run --full-refresh             # Force table rebuild`}
            />
          </SubSection>

          <SubSection id="cli-validate" title="Validate &amp; Lineage">
            <CodeBlock
              code={`bobsled model validate                       # Check specs without compiling
bobsled model lineage [model_name]           # Show dependency graph`}
            />
          </SubSection>

          <SubSection id="cli-bundles" title="Model Bundles">
            <CodeBlock
              code={`bobsled model models list                    # Browse prebuilt integration model bundles
bobsled model models info stripe             # Inspect one bundle
bobsled model models install stripe          # Write bundle specs into the current project`}
            />
          </SubSection>

          <SubSection id="cli-seeds" title="Seeds">
            <CodeBlock
              code={`bobsled model seed validate [--json]
bobsled model seed load [--runner ./r.js] [--json]
bobsled model seed diff --runner ./r.js [--json]`}
            />
          </SubSection>

          <SubSection id="cli-init" title="Init">
            <CodeBlock code={`bobsled model init my-project              # Scaffold new project`} />
          </SubSection>
        </Section>
      </div>

      {/* Sticky TOC — right rail on large screens */}
      <aside className="hidden lg:block w-44 shrink-0">
        <div className="sticky top-6">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
            On this page
          </div>
          <nav className="flex flex-col gap-1">
            {TOC.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </aside>
    </div>
  );
}
