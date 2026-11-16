import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { DashboardToolkitCatalog } from '@/components/dashboard/toolkit-catalog';
import { DashboardLaunchpad } from '@/components/journey/dashboard-launchpad';
import { PageHeader } from '@/components/ui/page-header';
import { listIntegrations } from '@/lib/integrations';
import { listModelPackages } from '@/lib/models';

const DESTINATIONS = [
  { type: 'duckdb', name: 'DuckDB', description: 'Local zero-infra analytics' },
  { type: 'bigquery', name: 'BigQuery', description: 'Google Cloud warehouse' },
  { type: 'snowflake', name: 'Snowflake', description: 'Enterprise cloud warehouse' },
  { type: 'postgres', name: 'PostgreSQL', description: 'Relational database' },
  { type: 'clickhouse', name: 'ClickHouse', description: 'Column-oriented OLAP database' },
  { type: 'turbopuffer', name: 'Turbopuffer', description: 'Serverless vector search' },
  { type: 'local', name: 'Local Files', description: 'JSONL / CSV / Parquet' },
  { type: 's3', name: 'S3', description: 'AWS object storage' },
  { type: 'gcs', name: 'GCS', description: 'Google Cloud Storage' },
];

const CAPABILITIES = [
  {
    title: 'Extract',
    description:
      'YAML-driven API extraction with pagination, incremental sync, rate limiting, and SSRF protection.',
    href: '/integrations',
    highlights: [
      '81 pre-built connectors',
      'Incremental cursor-based sync',
      'OAuth2 + API key auth',
      'Dogsled protocol JSONL',
    ],
  },
  {
    title: 'Load',
    description:
      'Multi-destination data loading with schema evolution, merge strategies, and batched writes.',
    href: '/pipelines/new',
    highlights: [
      '9 destination types',
      'Append / merge / full refresh',
      'Schema auto-detection',
      'DuckDB for local dev',
    ],
  },
  {
    title: 'Model',
    description:
      'SQL-based data transformation with multi-dialect compilation across Dogsled’s warehouse targets.',
    href: '/models',
    highlights: [
      'Source -> staging -> mart DAG',
      'Pre-built analytics bundles',
      'Multi-dialect SQL',
      'YAML-defined schemas',
    ],
  },
  {
    title: 'Pipeline',
    description:
      'Composed extract + load in a single command with schedule configuration and YAML-driven orchestration.',
    href: '/pipelines/new',
    highlights: [
      'One-command ELT',
      'Cron-based scheduling',
      'Resource selection',
      'bobsled.yml config file',
    ],
  },
  {
    title: 'Entity Graph',
    description:
      'Entity resolution with standardization, blocking, scoring, and threshold-based matching.',
    href: '/entity-graph',
    highlights: [
      'Jaro-Winkler / edit distance',
      'Configurable thresholds',
      'Human review routing',
      'Survivorship rules',
    ],
  },
];

export default function Dashboard() {
  const integrations = listIntegrations();
  const models = listModelPackages();

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <PageHeader
        title="Dogsled Explorer"
        description="Learn Dogsled through the curriculum, quick guides, runnable demos, and the underlying integration and model catalogs."
      />

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <Link href="/integrations" className="hover:text-foreground transition-colors">
          {integrations.length} integration{integrations.length === 1 ? '' : 's'}
        </Link>
        <Link href="/models" className="hover:text-foreground transition-colors">
          {models.length} model bundle{models.length === 1 ? '' : 's'}
        </Link>
        <Link href="/pipelines/new" className="hover:text-foreground transition-colors">
          {DESTINATIONS.length} destination{DESTINATIONS.length === 1 ? '' : 's'}
        </Link>
        <Link href="/entity-graph" className="hover:text-foreground transition-colors">
          Entity Graph
        </Link>
      </div>

      <DashboardLaunchpad />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Quick Actions</h2>
          <Link href="/journeys" className="text-xs text-primary hover:underline">
            Browse quick guides
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Link
            href="/integrations"
            className="rounded-2xl border border-info/20 bg-info/10 p-4 transition-colors hover:bg-info/15"
          >
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium text-info">Explore Integrations</div>
              <Badge variant="info">Popular</Badge>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Browse connectors, auth setup, and resource catalogs
            </div>
          </Link>
          <Link
            href="/learn"
            className="rounded-2xl border border-primary/20 bg-primary/10 p-4 transition-colors hover:bg-primary/15"
          >
            <div className="text-sm font-medium text-primary">Learn Dogsled</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Follow the full curriculum with commands and table inspection
            </div>
          </Link>
          <Link
            href="/pipelines/new"
            className="rounded-2xl border border-accent/20 bg-accent/10 p-4 transition-colors hover:bg-accent/15"
          >
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium text-accent">Build Pipeline</div>
              <Badge variant="accent">Popular</Badge>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Select sources, destinations, and export config
            </div>
          </Link>
          <Link
            href="/terminal"
            className="rounded-2xl border border-warning/20 bg-warning/10 p-4 transition-colors hover:bg-warning/15"
          >
            <div className="text-sm font-medium text-warning">Run Commands</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Execute Dogsled CLI commands with streaming output
            </div>
          </Link>
          <Link
            href="/operate/data"
            className="rounded-2xl border border-info/20 bg-info/10 p-4 transition-colors hover:bg-info/15"
          >
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium text-info">Query Data</div>
              <Badge variant="info">Popular</Badge>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Browse and query connected data sources and tables
            </div>
          </Link>
        </div>
      </section>

      <DashboardToolkitCatalog
        capabilities={CAPABILITIES}
        destinations={DESTINATIONS}
        initialIntegrations={integrations}
        initialModels={models}
      />
    </div>
  );
}
