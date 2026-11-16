import Link from 'next/link';
import { listIntegrations } from '@/lib/integrations';
import { listModelPackages } from '@/lib/models';

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
    <section id={id} className="scroll-mt-8">
      <h2 className="text-lg font-bold mt-8 mb-3 border-b border-border pb-2">{title}</h2>
      {children}
    </section>
  );
}

function SubSection({
  id,
  title,
  href,
  children,
}: {
  id: string;
  title: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="mt-6 scroll-mt-8">
      <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
        {title}
        {href && (
          <Link href={href} className="text-[10px] text-primary hover:underline font-normal">
            Open &rarr;
          </Link>
        )}
      </h3>
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

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-card border border-border rounded-lg p-3 text-[11px] font-mono overflow-auto mb-3 whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 mb-3">
      {items.map((item) => (
        <li key={item} className="text-xs text-muted-foreground flex items-start gap-2">
          <span className="text-accent mt-0.5">&#8226;</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function TableRow({ cells }: { cells: string[] }) {
  return (
    <tr className="border-b border-border">
      {cells.map((cell, i) => (
        <td key={i} className="px-3 py-1.5 text-[11px] font-mono">
          {cell}
        </td>
      ))}
    </tr>
  );
}

interface ApiRouteRow {
  route: string;
  method: string;
  purpose: string;
}

const ENTITY_GRAPH_API_ROUTES: readonly ApiRouteRow[] = [
  {
    route: '/api/entity-graph/specs',
    method: 'GET',
    purpose: 'List available Entity Graph demo specs',
  },
  {
    route: '/api/entity-graph/specs/[name]',
    method: 'GET/PUT',
    purpose: 'Read or update an Entity Graph YAML spec',
  },
  {
    route: '/api/entity-graph/run',
    method: 'POST',
    purpose: 'Seed + run the demo Entity Graph pipeline via SSE',
  },
  {
    route: '/api/entity-graph/runs',
    method: 'GET',
    purpose: 'Read recent entity graph run history',
  },
  { route: '/api/entity-graph/queue', method: 'GET', purpose: 'Load the live review queue' },
  { route: '/api/entity-graph/clusters', method: 'GET', purpose: 'Summarize resolved clusters' },
  {
    route: '/api/entity-graph/clusters/[id]',
    method: 'GET',
    purpose: 'Load one cluster detail view',
  },
  {
    route: '/api/entity-graph/decide',
    method: 'POST',
    purpose: 'Persist a review decision via dogsled entity-graph',
  },
  {
    route: '/api/entity-graph/agent-review',
    method: 'POST',
    purpose: 'Run the bounded agent-review flow',
  },
  {
    route: '/api/entity-graph/assistant',
    method: 'POST',
    purpose: 'Chat with the entity graph assistant rail',
  },
];

export default function DocsPage() {
  const integrations = listIntegrations();
  const models = listModelPackages();
  const totalResources = integrations.reduce((sum, i) => sum + i.resource_count, 0);
  const categories = [...new Set(integrations.map((i) => i.category))].sort();

  const toc = [
    { id: 'quick-start', label: 'Quick Start' },
    { id: 'pages', label: 'Pages' },
    { id: 'learn', label: 'Learn' },
    { id: 'journeys', label: 'Journeys' },
    { id: 'runs', label: 'Runs' },
    { id: 'agent', label: 'Agent Chat' },
    { id: 'integrations', label: 'Integrations' },
    { id: 'models', label: 'Models' },
    { id: 'pipelines', label: 'Pipeline Builder' },
    { id: 'operate-runs', label: 'Operate · Runs' },
    { id: 'operate-connections', label: 'Operate · Connections' },
    { id: 'data', label: 'Data Preview' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'docs-page', label: 'Docs' },
    { id: 'entity-graph', label: 'Entity Graph' },
    { id: 'setup', label: 'Setup Wizard' },
    { id: 'api-routes', label: 'API Routes' },
    { id: 'architecture', label: 'Architecture' },
    { id: 'reference', label: 'Reference' },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex gap-8">
        {/* Table of contents - sticky sidebar */}
        <nav className="hidden lg:block w-48 shrink-0">
          <div className="sticky top-6 space-y-1">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              On this page
            </div>
            {toc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="block text-xs text-muted-foreground hover:text-primary transition-colors py-0.5"
              >
                {item.label}
              </a>
            ))}
          </div>
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight">Dogsled Explorer Documentation</h1>
            <P>
              A local-first web UI for exploring, configuring, and demoing the Dogsled data
              engineering toolkit. Browse {integrations.length} integrations, {models.length} model
              bundles, build pipelines, preview data, and chat with an AI agent.
            </P>
          </div>

          {/* Live stats banner */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
            <div className="bg-card border border-border rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-primary">{integrations.length}</div>
              <div className="text-[10px] text-muted-foreground">Integrations</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-primary">{totalResources}</div>
              <div className="text-[10px] text-muted-foreground">API Resources</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-primary">{models.length}</div>
              <div className="text-[10px] text-muted-foreground">Model Bundles</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-primary">{categories.length}</div>
              <div className="text-[10px] text-muted-foreground">Categories</div>
            </div>
          </div>

          <Section id="quick-start" title="Quick Start">
            <CodeBlock>{`# From the monorepo root
pnpm run setup                                  # Install deps + build all
pnpm --filter @bobsled-inc/explorer dev         # http://localhost:3333`}</CodeBlock>
            <P>
              The explorer reads integration and model data directly from workspace packages. No
              database, no cloud services, no API keys required. The optional Agent page needs{' '}
              <Code>claude</Code> CLI in your PATH.
            </P>
          </Section>

          <Section id="pages" title="Pages">
            <SubSection id="dashboard" title="Dashboard" href="/">
              <P>
                Your launchpad for exploring Dogsled. Shows stats at a glance, all five Dogsled
                capabilities (Extract, Load, Model, Pipeline, Entity Graph), quick action cards,
                integrations by category, all 7 load destinations, model bundles, and popular
                integrations.
              </P>
            </SubSection>

            <SubSection id="learn" title="Learn" href="/learn">
              <P>
                Comprehensive curriculum that mirrors the expanded CLI learning scope with visual
                modules, progress tracking, runnable commands, SQL inspection, safe table samples,
                and credential-aware branches.
              </P>
              <FeatureList
                items={[
                  'Grouped modules for foundations, Model Spec/context, Entity Graph, MCP extraction, advanced ELT, and warehouses',
                  'Step kinds for concepts, surfaces, commands, queries, tables, specs, and checks',
                  'Progress stored in localStorage by curriculum version',
                  'Entity Graph table atlas covering review, components, clusters, IDs, golden history, relationships, audit, lineage, and metadata',
                ]}
              />
            </SubSection>

            <SubSection id="journeys" title="Journeys" href="/journeys">
              <P>
                Lightweight quick guides that link major explorer surfaces together into runnable
                workflows. Use Learn for the comprehensive curriculum.
              </P>
              <FeatureList
                items={[
                  'Scenario-based walkthroughs like the SaaS pipeline and customer resolution demos',
                  'Per-step instructions, badges, and prefilled terminal commands',
                  'Direct links into the builder, terminal, data preview, and Entity Graph surfaces',
                ]}
              />
            </SubSection>

            <SubSection id="runs" title="Runs" href="/terminal?tab=history">
              <P>
                Local run history for recent terminal sessions, including replay links and quick
                jumps back into DuckDB results.
              </P>
              <FeatureList
                items={[
                  'Filter by status, integration, and date range',
                  'Expand saved stdout for recent executions',
                  'Re-run single commands or multi-command pipeline batches in Terminal',
                ]}
              />
            </SubSection>

            <SubSection id="agent" title="Agent Chat" href="/agent">
              <P>
                Conversational AI assistant powered by your local Claude Code installation. Ask
                freeform questions about Dogsled&apos;s integrations, models, pipelines, and
                capabilities.
              </P>
              <FeatureList
                items={[
                  'System prompt dynamically built from actual catalog data (always current)',
                  'Streaming responses via Server-Sent Events',
                  'Multi-turn conversation with history context',
                  '8 suggested starter questions',
                  'Stop button for long responses',
                  'Requires claude CLI in PATH (install via npm install -g @anthropic-ai/claude-code)',
                ]}
              />
            </SubSection>

            <SubSection id="integrations" title="Integrations" href="/integrations">
              <P>
                Browse all {integrations.length} API connectors with search, category filter, and
                type filter (API, Database, MCP). Cards show resource counts and &quot;model
                bundle&quot; badges.
              </P>
              <div className="bg-card border border-border rounded-lg p-3 mb-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                  Categories
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {categories.map((cat) => (
                    <Link
                      key={cat}
                      href={`/integrations?category=${cat}`}
                      className="text-[10px] bg-secondary text-muted-foreground px-1.5 py-0.5 rounded hover:text-primary transition-colors"
                    >
                      {cat.replace(/-/g, ' ')}
                    </Link>
                  ))}
                </div>
              </div>
              <P>
                Click any integration for the full detail page: auth setup instructions, transport
                config, and expandable resource cards with input/output schemas, pagination types,
                and primary keys. Integrations with pre-built model bundles show a prominent link to
                the model page.
              </P>
            </SubSection>

            <SubSection id="models" title="Models" href="/models">
              <P>
                Browse {models.length} pre-built analytics model bundles. Each follows the source
                &rarr; staging &rarr; mart DAG pattern.
              </P>
              <FeatureList
                items={[
                  'Expandable spec cards with full column details (name, type, PK, semantic role, expression)',
                  'Visual DAG summary showing source → staging → mart flow',
                  'File browser with side-by-side content viewer',
                  'Cross-link to the data source integration when one exists',
                ]}
              />
              <div className="bg-card border border-border rounded-lg p-3 mb-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                  Available Bundles
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {models.map((m) => (
                    <Link
                      key={m.name}
                      href={`/models/${m.name}`}
                      className="text-[10px] text-muted-foreground hover:text-primary transition-colors"
                    >
                      {m.displayName} ({m.martCount} marts)
                    </Link>
                  ))}
                </div>
              </div>
            </SubSection>

            <SubSection id="pipelines" title="Pipeline Builder" href="/pipelines/new">
              <P>6-step wizard to configure an extract + load pipeline:</P>
              <FeatureList
                items={[
                  'Preset — SaaS Analytics, CRM RevOps, Ad Spend, Support Ops, or Custom',
                  'Integrations — select from all connectors (pre-filled from preset)',
                  'Resources — pick specific API resources with Select All and incremental indicators',
                  'Destination — DuckDB, BigQuery, Snowflake, PostgreSQL, ClickHouse, Turbopuffer, Local, S3, or GCS',
                  'Schedule — hourly, every 4h, daily, weekly, or custom',
                  'Review — generated bobsled.yml with copy, export, and "Run in Terminal" buttons',
                ]}
              />
              <P>
                From the review step, click <strong>Export Options</strong> to get your config as
                bobsled.yml or CLI commands. The export page dynamically generates both formats from
                your actual configuration, and the terminal CTA runs every selected integration in
                sequence.
              </P>
            </SubSection>

            <SubSection
              id="operate-connections"
              title="Operate · Connections"
              href="/operate/connections"
            >
              <P>
                Credential vault for saved data source connections. Add BigQuery, Snowflake,
                PostgreSQL, DuckDB, S3, or GCS credentials once and reuse them across the pipeline
                wizard and Data editor.
              </P>
              <FeatureList
                items={[
                  'Stored in localStorage — no server-side secrets storage',
                  '"Test connection" probe validates credentials before saving',
                  'Connections appear in the Pipeline Builder destination step',
                  'Connection-aware Data editor surfaces saved connections in the database picker',
                ]}
              />
            </SubSection>

            <SubSection id="data" title="Data Preview" href="/operate/data">
              <P>
                Query DuckDB data and inspect saved connections from the OPERATE data surface.
                Supports local files, saved DuckDB connections, and warehouse-backed connections.
              </P>
              <FeatureList
                items={[
                  'Saved connections and connection-aware querying',
                  'Quick queries: "Show tables" and "Table sizes"',
                  'SQL editor with Ctrl+Enter to execute',
                  'Results table with column headers, null handling, row count',
                ]}
              />
            </SubSection>

            <SubSection id="terminal" title="Terminal" href="/terminal">
              <P>
                Interactive Dogsled CLI runner. Commands are automatically prefixed with{' '}
                <Code>dogsled</Code> — just type <Code>integrations list --type api</Code>.
              </P>
              <FeatureList
                items={[
                  '8 quick command buttons (list integrations, show stripe, help pages, etc.)',
                  'Streaming output with Dogsled protocol parsing (LOG, METRIC, PROGRESS, SCHEMA, RECORD)',
                  'Color-coded messages by type and severity',
                  'Command history with up/down arrow keys',
                  'Stop button and Ctrl+C support',
                ]}
              />
            </SubSection>

            <SubSection id="docs-page" title="Docs" href="/docs">
              <P>
                The in-product reference you are reading now. It mirrors the shipped explorer
                routes, API surface, and high-value Dogsled CLI commands.
              </P>
            </SubSection>

            <SubSection
              id="entity-graph"
              title="Entity Graph Hub, Design, and Resolve"
              href="/entity-graph"
            >
              <P>
                The Entity Graph surface is split across a hub (<Code>/entity-graph</Code>), a
                design workspace (<Code>/entity-graph/design</Code>), and an execution workspace (
                <Code>/entity-graph/resolve</Code>, plus{' '}
                <Code>/entity-graph/resolve/clusters/[id]</Code>).
              </P>
              <FeatureList
                items={[
                  'Hub page with demo overview, saved-spec entry points, and recent run context',
                  'Design flow for authoring entity, inputs, standardize, blocking, scoring, and thresholds',
                  'Resolve page with live review queue, clusters, runs, and assistant context',
                  'Demo runner that seeds DuckDB before resolve, cluster, profile, and survivorship steps',
                ]}
              />
            </SubSection>

            <SubSection id="setup" title="Setup Wizard" href="/setup">
              <P>
                Chat-style guided configuration. Connects to Dogsled&apos;s setup APIs when
                available, falls back to built-in presets otherwise.
              </P>
              <FeatureList
                items={[
                  'Describe your goal in plain English',
                  'Get AI-powered preset recommendation (when dogsled CLI available)',
                  '5 presets: SaaS Analytics, CRM RevOps, Ad Spend, Support Ops, Finance Ops',
                  'Destination selection with descriptions',
                  'Schedule picker',
                  'Summary with next steps linking to Pipeline Builder and Terminal',
                ]}
              />
            </SubSection>
          </Section>

          <Section id="api-routes" title="API Routes">
            <div className="bg-card border border-border rounded-lg overflow-hidden mb-3">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-secondary/50">
                    <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                      Route
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                      Method
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                      Purpose
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <TableRow
                    cells={[
                      '/api/integrations',
                      'GET',
                      'List integrations with search/category/type filters',
                    ]}
                  />
                  <TableRow
                    cells={[
                      '/api/integrations/[name]',
                      'GET',
                      'Integration detail with resources + model bundle link',
                    ]}
                  />
                  <TableRow cells={['/api/models', 'GET', 'List model packages']} />
                  <TableRow
                    cells={['/api/models/[name]', 'GET', 'Model package detail + integration link']}
                  />
                  <TableRow cells={['/api/command', 'POST', 'Execute dogsled CLI → SSE stream']} />
                  <TableRow cells={['/api/query', 'POST', 'SQL query against local DuckDB']} />
                  <TableRow
                    cells={['/api/setup/describe', 'GET', 'Setup catalog from dogsled CLI']}
                  />
                  <TableRow
                    cells={['/api/setup/recommend', 'POST', 'Goal → pipeline recommendation']}
                  />
                  <TableRow cells={['/api/agent', 'POST', 'Chat with Claude Code → SSE stream']} />
                  <TableRow
                    cells={[
                      '/api/learn/credentials',
                      'GET',
                      'Presence-only credential checks for Learn modules',
                    ]}
                  />
                  <TableRow
                    cells={[
                      '/api/learn/entity-graph/table',
                      'GET',
                      'Whitelisted Entity Graph table inventory and samples',
                    ]}
                  />
                  <TableRow
                    cells={[
                      '/api/connections/test',
                      'POST',
                      'Test a saved connection for validity',
                    ]}
                  />
                  <TableRow
                    cells={[
                      '/api/entity-graph/query',
                      'POST',
                      'Read-only SELECT against Entity Graph workspace DuckDB',
                    ]}
                  />
                  {ENTITY_GRAPH_API_ROUTES.map((row) => (
                    <TableRow
                      key={`${row.route}:${row.method}`}
                      cells={[row.route, row.method, row.purpose]}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="architecture" title="Architecture">
            <CodeBlock>{`Browser ──→ Next.js App ──→ @bobsled-inc/integrations (YAML catalog)
                         ──→ @bobsled-inc/models (model bundles)
                         ──→ dogsled CLI subprocess (commands, queries, setup)
                         ──→ claude CLI subprocess (agent chat)`}</CodeBlock>
            <P>
              The explorer is a Next.js 15 app using the App Router. Integration and model data is
              read directly from workspace packages (server-side). Command execution, data queries,
              and agent chat spawn subprocesses and stream results back via Server-Sent Events.
            </P>

            <SubSection id="design-decisions" title="Key Design Decisions">
              <FeatureList
                items={[
                  'No database — all data from YAML specs or CLI subprocesses',
                  'Server-Sent Events for streaming command output and agent chat',
                  'YAML cache clearing after every request to prevent memory leaks',
                  'Command whitelist — only allowed dogsled subcommands can execute',
                  'Dynamic agent system prompt built from actual catalog data',
                  'Pipeline config passed to export page via base64 URL parameter',
                  'ESM bundler mode — Next.js uses its own bundler, not NodeNext',
                ]}
              />
            </SubSection>
          </Section>

          <Section id="reference" title="Reference">
            <SubSection id="cli-commands" title="Useful Dogsled CLI Commands">
              <div className="bg-card border border-border rounded-lg overflow-hidden mb-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-secondary/50">
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                        Command
                      </th>
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                        Description
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <TableRow
                      cells={['dogsled integrations list', 'List all available integrations']}
                    />
                    <TableRow
                      cells={['dogsled integrations show <name>', 'Show integration details']}
                    />
                    <TableRow
                      cells={[
                        'dogsled extract run <integration>',
                        'Extract data from an integration',
                      ]}
                    />
                    <TableRow
                      cells={[
                        'dogsled pipeline --integration <name>',
                        'Extract + load in one command',
                      ]}
                    />
                    <TableRow
                      cells={['dogsled model compile --dialect <x>', 'Compile SQL models']}
                    />
                    <TableRow cells={['dogsled setup describe --json', 'Show setup catalog']} />
                    <TableRow
                      cells={['dogsled setup recommend --goal "..."', 'Get recommendations']}
                    />
                    <TableRow cells={['dogsled load query --db-path <db> "..."', 'Query DuckDB']} />
                  </tbody>
                </table>
              </div>
            </SubSection>

            <SubSection id="destinations" title="Supported Destinations">
              <div className="bg-card border border-border rounded-lg overflow-hidden mb-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-secondary/50">
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                        Destination
                      </th>
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                        Best For
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <TableRow cells={['DuckDB', 'Local dev, demos, zero-infra analytics']} />
                    <TableRow cells={['BigQuery', 'Google Cloud analytics, shared reporting']} />
                    <TableRow cells={['Snowflake', 'Enterprise cloud data warehouse']} />
                    <TableRow
                      cells={['PostgreSQL', 'Operational analytics, relational workloads']}
                    />
                    <TableRow cells={['Local Files', 'JSONL/CSV/Parquet export']} />
                    <TableRow cells={['S3', 'AWS data lake, archival']} />
                    <TableRow cells={['GCS', 'Google Cloud data lake']} />
                  </tbody>
                </table>
              </div>
            </SubSection>

            <SubSection id="load-strategies" title="Load Strategies">
              <FeatureList
                items={[
                  'append — Insert new rows (default)',
                  'merge — Upsert based on primary key',
                  'full_refresh — Drop and recreate table',
                ]}
              />
            </SubSection>

            <SubSection id="keyboard-shortcuts" title="Keyboard Shortcuts">
              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-secondary/50">
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                        Page
                      </th>
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                        Shortcut
                      </th>
                      <th className="text-left px-3 py-2 text-[10px] text-muted-foreground font-medium">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <TableRow cells={['Terminal', 'Enter', 'Run command']} />
                    <TableRow cells={['Terminal', 'Up/Down', 'Command history']} />
                    <TableRow cells={['Terminal', 'Ctrl+C', 'Stop command']} />
                    <TableRow cells={['Data', 'Ctrl+Enter', 'Execute query']} />
                    <TableRow cells={['Agent', 'Enter', 'Send message']} />
                  </tbody>
                </table>
              </div>
            </SubSection>
          </Section>
        </div>
      </div>
    </div>
  );
}
