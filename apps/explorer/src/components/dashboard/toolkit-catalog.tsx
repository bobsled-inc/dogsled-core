'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { DashboardIntegrationSummary, DashboardModelSummary } from '@/lib/dashboard-data';
import {
  parseDashboardIntegrationsResponse,
  parseDashboardModelsResponse,
} from '@/lib/dashboard-data';
import { loadStoredString } from '@/lib/storage';

interface Capability {
  title: string;
  description: string;
  href: string;
  highlights: string[];
}

interface Destination {
  type: string;
  name: string;
  description: string;
}

const VISITED_STORAGE_KEY = 'dogsled-explorer-visited';

export function DashboardToolkitCatalog({
  capabilities,
  destinations,
  initialIntegrations,
  initialModels,
}: {
  capabilities: Capability[];
  destinations: Destination[];
  initialIntegrations: DashboardIntegrationSummary[];
  initialModels: DashboardModelSummary[];
}) {
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [models, setModels] = useState(initialModels);
  const [hasVisited, setHasVisited] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const visited = loadStoredString(VISITED_STORAGE_KEY, '');
    if (visited === 'true' || visited === '"true"') {
      setHasVisited(true);
      return;
    }

    setHasVisited(false);
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(VISITED_STORAGE_KEY, 'true');
      setHasVisited(true);
    }, 5000);

    return () => window.clearTimeout(timer);
  }, []);

  const markVisited = () => {
    window.localStorage.setItem(VISITED_STORAGE_KEY, 'true');
    setHasVisited(true);
  };

  const refreshStats = async () => {
    setRefreshing(true);
    try {
      const [integrationResponse, modelResponse] = await Promise.all([
        fetch('/api/integrations'),
        fetch('/api/models'),
      ]);

      if (integrationResponse.ok) {
        const data = await integrationResponse.json();
        const nextIntegrations = parseDashboardIntegrationsResponse(data);
        if (nextIntegrations) {
          setIntegrations(nextIntegrations);
        }
      }

      if (modelResponse.ok) {
        const data = await modelResponse.json();
        const nextModels = parseDashboardModelsResponse(data);
        if (nextModels) {
          setModels(nextModels);
        }
      }
    } finally {
      setRefreshing(false);
    }
  };

  const categoryBreakdown = useMemo(
    () =>
      [...new Set(integrations.map((integration) => integration.category))]
        .map((category) => ({
          name: category,
          count: integrations.filter((integration) => integration.category === category).length,
        }))
        .sort((left, right) => right.count - left.count),
    [integrations]
  );

  const typeBreakdown = useMemo(
    () => [
      {
        name: 'API',
        type: 'api',
        count: integrations.filter((integration) => integration.integration_type === 'api').length,
      },
      {
        name: 'Database',
        type: 'db',
        count: integrations.filter((integration) => integration.integration_type === 'db').length,
      },
      {
        name: 'MCP',
        type: 'mcp',
        count: integrations.filter((integration) => integration.integration_type === 'mcp').length,
      },
    ],
    [integrations]
  );
  const popularIntegrations = useMemo(
    () =>
      integrations
        .slice()
        .sort((left, right) => right.resource_count - left.resource_count)
        .slice(0, 8),
    [integrations]
  );

  const totalResources = integrations.reduce(
    (sum, integration) => sum + integration.resource_count,
    0
  );
  const totalMarts = models.reduce((sum, model) => sum + model.martCount, 0);

  const stats = [
    { label: 'Integrations', value: integrations.length, href: '/integrations' },
    { label: 'API Resources', value: totalResources, href: '/integrations' },
    { label: 'Model Bundles', value: models.length, href: '/models' },
    { label: 'Analytics Marts', value: totalMarts, href: '/models' },
    { label: 'Destinations', value: destinations.length, href: '/pipelines/new' },
    { label: 'Categories', value: categoryBreakdown.length, href: '/integrations' },
  ];

  return (
    <>
      {!hasVisited && (
        <section className="rounded-[28px] border border-primary/20 bg-primary/10 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-primary">
                Get Started in 3 Steps
              </div>
              <h2 className="mt-2 text-xl font-semibold">From discovery to a runnable pipeline</h2>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Follow the same flow most developers use the first time they kick the tires on
                Dogsled Explorer.
              </p>
            </div>
            <Badge variant="accent">New session</Badge>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {[
              {
                href: '/integrations',
                label: '1. Pick an integration',
                body: 'Browse connectors, resources, auth setup, and model bundle availability.',
              },
              {
                href: '/pipelines/new',
                label: '2. Build a pipeline',
                body: 'Choose sources, resources, destination, and schedule, then export dogsled.yml.',
              },
              {
                href: '/terminal',
                label: '3. Run it',
                body: 'Kick off the CLI with streaming output and jump straight into DuckDB results.',
              },
            ].map((step) => (
              <Link
                key={step.href}
                href={step.href}
                onClick={markVisited}
                className="rounded-2xl border border-border bg-card/70 p-4 transition-colors hover:border-primary/40"
              >
                <div className="text-sm font-medium">{step.label}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.body}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <details className="group rounded-[28px] border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4">
          <div>
            <div className="text-sm font-semibold">Explore the Toolkit</div>
            <p className="mt-1 text-xs text-muted-foreground">
              The catalog view is still here when you want counts, capabilities, destinations, and
              popular connectors.
            </p>
          </div>
          <span className="text-xs text-primary transition-transform group-open:rotate-45">+</span>
        </summary>

        <div className="space-y-8 border-t border-border px-6 py-6">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Explorer Stats</h2>
              <button
                type="button"
                onClick={() => void refreshStats()}
                disabled={refreshing}
                className="rounded-full border border-border p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                aria-label="Refresh stats"
                title="Refresh stats"
              >
                <svg
                  className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.023 9.348h4.992V4.356m-1.53 13.292a9 9 0 11.514-8.804"
                  />
                </svg>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              {stats.map((stat) => (
                <Link
                  key={stat.label}
                  href={stat.href}
                  className="rounded-2xl border border-border bg-secondary/30 p-4 transition-colors hover:border-primary/40"
                >
                  <div className="text-2xl font-semibold text-primary">{stat.value}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{stat.label}</div>
                </Link>
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold">Dogsled Capabilities</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {capabilities.map((capability) => (
                <Link
                  key={capability.title}
                  href={capability.href}
                  className="group rounded-2xl border border-border bg-secondary/20 p-4 transition-colors hover:border-primary/40"
                >
                  <div className="text-sm font-semibold transition-colors group-hover:text-primary">
                    {capability.title}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {capability.description}
                  </p>
                  <div className="mt-3 space-y-1.5">
                    {capability.highlights.map((highlight) => (
                      <div
                        key={highlight}
                        className="flex items-center gap-2 text-[11px] text-muted-foreground"
                      >
                        <span className="text-accent">•</span>
                        <span>{highlight}</span>
                      </div>
                    ))}
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            <div>
              <h2 className="mb-3 text-sm font-semibold">Integrations by Category</h2>
              <div className="divide-y divide-border rounded-2xl border border-border bg-secondary/20">
                {categoryBreakdown.map((category) => (
                  <Link
                    key={category.name}
                    href={`/integrations?category=${category.name}`}
                    className="flex items-center justify-between px-4 py-3 text-xs transition-colors hover:bg-secondary/50"
                  >
                    <span className="capitalize">{category.name.replace(/-/g, ' ')}</span>
                    <span className="tabular-nums text-muted-foreground">{category.count}</span>
                  </Link>
                ))}
              </div>

              <div className="mt-3">
                <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  By Type
                </div>
                <div className="flex gap-2">
                  {typeBreakdown.map((typeItem) => (
                    <Link
                      key={typeItem.name}
                      href={`/integrations?type=${typeItem.type}`}
                      className="flex-1 rounded-2xl border border-border bg-secondary/20 p-3 text-center transition-colors hover:border-primary/40"
                    >
                      <div className="text-lg font-semibold">{typeItem.count}</div>
                      <div className="text-[10px] text-muted-foreground">{typeItem.name}</div>
                    </Link>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <h2 className="mb-3 text-sm font-semibold">Load Destinations</h2>
              <div className="divide-y divide-border rounded-2xl border border-border bg-secondary/20">
                {destinations.map((destination) => (
                  <Link
                    key={destination.type}
                    href="/pipelines/new"
                    className="flex items-center justify-between gap-3 px-4 py-3 text-xs transition-colors hover:bg-secondary/50"
                  >
                    <span className="font-medium">{destination.name}</span>
                    <span className="text-muted-foreground">{destination.description}</span>
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Popular Integrations</h2>
                <Link href="/integrations" className="text-xs text-primary hover:underline">
                  View all {integrations.length}
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-2">
                {popularIntegrations.map((integration) => (
                  <Link
                    key={integration.name}
                    href={`/integrations/${integration.name}`}
                    className="rounded-2xl border border-border bg-secondary/20 p-3 transition-colors hover:border-primary/40"
                  >
                    <div className="text-xs font-medium">{integration.display_name}</div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                      <span className="capitalize">{integration.category.replace(/-/g, ' ')}</span>
                      <span>{integration.resource_count} resources</span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      </details>
    </>
  );
}
