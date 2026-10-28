'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { LoadingSkeleton } from '@/components/ui/loading-skeleton';
import { PageHeader } from '@/components/ui/page-header';

interface IntegrationSummary {
  name: string;
  display_name: string;
  category: string;
  tags: string[];
  resource_count: number;
  integration_type: string;
  hasModelBundle?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  api: 'API',
  db: 'Database',
  mcp: 'MCP',
};

function IntegrationsLoadingState() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="rounded-2xl border border-border bg-card p-4">
          <LoadingSkeleton className="h-4 w-32" />
          <LoadingSkeleton className="mt-2 h-3 w-20" />
          <div className="mt-4 flex gap-2">
            <LoadingSkeleton className="h-5 w-16 rounded-full" />
            <LoadingSkeleton className="h-5 w-24 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function IntegrationsPageWrapper() {
  return (
    <Suspense
      fallback={
        <div className="p-6">
          <IntegrationsLoadingState />
        </div>
      }
    >
      <IntegrationsPage />
    </Suspense>
  );
}

function IntegrationsPage() {
  const searchParams = useSearchParams();
  const initialCategory = searchParams.get('category') ?? 'all';

  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(initialCategory);
  const [type, setType] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/integrations')
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load integrations');
        return response.json();
      })
      .then((data: { integrations: IntegrationSummary[]; categories: string[] }) => {
        setIntegrations(data.integrations);
        setCategories(data.categories);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, []);

  const filtered = useMemo(() => {
    let result = integrations;
    if (search) {
      const query = search.toLowerCase();
      result = result.filter(
        (integration) =>
          integration.name.includes(query) ||
          integration.display_name.toLowerCase().includes(query) ||
          integration.tags.some((tag) => tag.includes(query))
      );
    }
    if (category !== 'all') {
      result = result.filter((integration) => integration.category === category);
    }
    if (type !== 'all') {
      result = result.filter((integration) => integration.integration_type === type);
    }
    return result;
  }, [integrations, search, category, type]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Integrations"
        description={`Browse ${integrations.length} available data source connectors and jump straight into resource-level details.`}
      />

      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search integrations..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-64 rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">All Categories</option>
          {categories.map((categoryOption) => (
            <option key={categoryOption} value={categoryOption}>
              {categoryOption.replace(/-/g, ' ')}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(event) => setType(event.target.value)}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">All Types</option>
          <option value="api">API</option>
          <option value="db">Database</option>
          <option value="mcp">MCP</option>
        </select>
        <span className="ml-auto self-center text-xs text-muted-foreground">
          {filtered.length} result{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading ? (
        <IntegrationsLoadingState />
      ) : error ? (
        <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-4">
          <div className="text-xs text-destructive">{error}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((integration) => (
            <Link
              key={integration.name}
              href={`/integrations/${integration.name}`}
              className="group rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
            >
              <div>
                <div className="text-sm font-semibold transition-colors group-hover:text-primary">
                  {integration.display_name}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{integration.name}</div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge>{integration.category.replace(/-/g, ' ')}</Badge>
                {integration.hasModelBundle && <Badge variant="primary">model bundle</Badge>}
                <Badge variant="muted" className="text-[10px]">
                  {TYPE_LABELS[integration.integration_type] ?? integration.integration_type}
                </Badge>
                <span className="ml-auto text-sm font-medium">
                  <span className="text-foreground">{integration.resource_count}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    resource{integration.resource_count !== 1 ? 's' : ''}
                  </span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
