'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { summarizeHealthCheck } from '@/lib/command-insights';
import {
  parseIntegrationDetail,
  type IntegrationDetail,
  type ResourceSpec,
} from '@/lib/integration-detail';
import { Badge } from '@/components/ui/badge';
import { LoadingSkeleton } from '@/components/ui/loading-skeleton';
import { PageHeader } from '@/components/ui/page-header';
import { useCommand } from '@/lib/use-command';

const EMPTY_RESOURCES: ResourceSpec[] = [];

function ResourceDetail({
  collapseKey,
  resource,
}: {
  collapseKey: string;
  resource: ResourceSpec;
}) {
  const [expanded, setExpanded] = useState(false);
  const outputFields = resource.output ? Object.entries(resource.output) : [];
  const inputFields = resource.input ? Object.entries(resource.input) : [];
  const primaryKeys = resource.extract?.table?.primary_key ?? [];
  const detailsId = `${resource.name}-details`;

  useEffect(() => {
    setExpanded(false);
  }, [collapseKey]);

  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-secondary/50"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">{resource.name}</span>
          {resource.api?.method && <Badge variant="primary">{resource.api.method}</Badge>}
          {resource.billing?.mode === 'billable' && <Badge variant="warning">billable</Badge>}
          {resource.extract?.incremental && <Badge variant="accent">incremental</Badge>}
          {resource.lookup && <Badge>lookup</Badge>}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{outputFields.length} fields</span>
          <span>{expanded ? '−' : '+'}</span>
        </div>
      </button>

      {expanded && (
        <div id={detailsId} className="space-y-4 border-t border-border p-4">
          {resource.description && (
            <p className="text-xs text-muted-foreground">{resource.description}</p>
          )}

          {resource.api?.endpoint && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Endpoint
              </div>
              <code className="block overflow-x-auto rounded-md bg-secondary px-2 py-1 text-xs">
                {resource.api.method ?? 'GET'} {resource.api.endpoint}
              </code>
            </div>
          )}

          {resource.tool?.tool_name && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                MCP Tool
              </div>
              <code className="rounded-md bg-secondary px-2 py-1 text-xs">
                {resource.tool.tool_name}
              </code>
            </div>
          )}

          {resource.extract && (
            <div className="flex flex-wrap gap-3">
              {resource.extract.record_path && (
                <div>
                  <div className="mb-0.5 text-[10px] text-muted-foreground">Record Path</div>
                  <code className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px]">
                    {resource.extract.record_path}
                  </code>
                </div>
              )}
              {resource.extract.pagination?.type && (
                <div>
                  <div className="mb-0.5 text-[10px] text-muted-foreground">Pagination</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{resource.extract.pagination.type}</Badge>
                  </div>
                </div>
              )}
              {resource.extract.incremental?.cursor_field && (
                <div>
                  <div className="mb-0.5 text-[10px] text-muted-foreground">Cursor Field</div>
                  <code className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px]">
                    {resource.extract.incremental.cursor_field}
                  </code>
                </div>
              )}
              {resource.extract.table?.trust_tier && (
                <div>
                  <div className="mb-0.5 text-[10px] text-muted-foreground">Trust Tier</div>
                  <Badge
                    variant={resource.extract.table.trust_tier === 'gold' ? 'accent' : 'default'}
                  >
                    {resource.extract.table.trust_tier}
                  </Badge>
                </div>
              )}
            </div>
          )}

          {inputFields.length > 0 && (
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Input Parameters
              </div>
              <div className="overflow-hidden rounded-2xl bg-secondary/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                        Type
                      </th>
                      <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                        Required
                      </th>
                      <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                        Description
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {inputFields.map(([name, field]) => (
                      <tr key={name}>
                        <td className="px-3 py-1.5 font-mono text-[11px]">{name}</td>
                        <td className="px-3 py-1.5">
                          <Badge>{field.type ?? 'string'}</Badge>
                        </td>
                        <td className="px-3 py-1.5 text-[10px]">{field.required ? 'yes' : '-'}</td>
                        <td className="max-w-xs px-3 py-1.5 text-[10px] text-muted-foreground">
                          {field.description ?? '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {outputFields.length > 0 && (
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Output Schema
              </div>
              <div className="overflow-hidden rounded-2xl bg-secondary/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                        Field
                      </th>
                      <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                        Type
                      </th>
                      <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                        Path
                      </th>
                      <th className="px-3 py-1.5 text-left text-[10px] font-medium text-muted-foreground">
                        Key
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {outputFields.map(([name, field]) => (
                      <tr key={name}>
                        <td className="px-3 py-1.5 font-mono text-[11px]">{name}</td>
                        <td className="px-3 py-1.5">
                          <Badge variant="primary">{field.type ?? 'string'}</Badge>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                          {field.path ?? '-'}
                        </td>
                        <td className="px-3 py-1.5 text-[10px]">
                          {primaryKeys.includes(name) ? 'PK' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IntegrationDetailLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <LoadingSkeleton className="h-3 w-32" />
      <LoadingSkeleton className="h-8 w-56" />
      <LoadingSkeleton className="h-5 w-40 rounded-full" />
      <LoadingSkeleton className="h-28 w-full rounded-3xl" />
      <LoadingSkeleton className="h-24 w-full rounded-3xl" />
    </div>
  );
}

export default function IntegrationDetailPage() {
  const params = useParams();
  const nameParam = Array.isArray(params.name) ? params.name[0] : params.name;
  const name = typeof nameParam === 'string' && nameParam.length > 0 ? nameParam : null;
  const [data, setData] = useState<IntegrationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resourceSearch, setResourceSearch] = useState('');
  const [incrementalOnly, setIncrementalOnly] = useState(false);
  const [billableOnly, setBillableOnly] = useState(false);
  const [collapseKey, setCollapseKey] = useState('initial');
  const {
    running: healthChecking,
    outputs: healthOutputs,
    exitCode: healthExitCode,
    error: healthError,
    run: runHealthCheck,
  } = useCommand();

  useEffect(() => {
    if (!name) {
      setError('Integration route is invalid.');
      setLoading(false);
      return;
    }

    fetch(`/api/integrations/${name}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Integration "${name}" not found`);
        return response.json();
      })
      .then((payload: unknown) => {
        const detail = parseIntegrationDetail(payload);
        if (!detail) {
          throw new Error(`Integration "${name}" returned an invalid payload.`);
        }
        setData(detail);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [name]);

  useEffect(() => {
    setCollapseKey(`${resourceSearch}|${incrementalOnly}|${billableOnly}`);
  }, [billableOnly, incrementalOnly, resourceSearch]);

  const resources = data?.resources ?? EMPTY_RESOURCES;
  const filteredResources = useMemo(() => {
    const search = resourceSearch.trim().toLowerCase();
    return resources.filter((resource) => {
      const matchesSearch =
        search.length === 0 ||
        resource.name.toLowerCase().includes(search) ||
        resource.description?.toLowerCase().includes(search);
      const matchesIncremental = !incrementalOnly || Boolean(resource.extract?.incremental);
      const matchesBillable = !billableOnly || resource.billing?.mode === 'billable';
      return matchesSearch && matchesIncremental && matchesBillable;
    });
  }, [billableOnly, resources, incrementalOnly, resourceSearch]);

  if (loading) return <IntegrationDetailLoading />;
  if (error || !data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <PageHeader
          title="Integration not found"
          description={error ?? 'The requested integration could not be loaded.'}
          breadcrumbs={[
            { label: 'Integrations', href: '/integrations' },
            { label: 'Missing Integration' },
          ]}
        />
        <Link href="/integrations" className="text-sm text-primary hover:underline">
          Back to Integrations
        </Link>
      </div>
    );
  }

  const authType = data.spec.transport?.auth?.type ?? data.spec.transport?.type ?? 'unknown';
  const rateLimit = data.spec.transport?.rate_limit;
  const healthStatus = summarizeHealthCheck(healthOutputs, healthExitCode, healthError);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title={data.meta.display_name}
        description={`${data.resources.length} resource${data.resources.length !== 1 ? 's' : ''} available for exploration.`}
        breadcrumbs={[
          { label: 'Integrations', href: '/integrations' },
          { label: data.meta.display_name },
        ]}
        actions={
          data.meta.docs_url ? (
            <a
              href={data.meta.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              API Docs
            </a>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge>{data.meta.category.replace(/-/g, ' ')}</Badge>
        <Badge variant="primary">{authType} auth</Badge>
        {rateLimit?.requests_per_second && (
          <Badge variant="info">
            {rateLimit.requests_per_second} req/s
            {rateLimit.burst ? ` • ${rateLimit.burst} burst` : ''}
          </Badge>
        )}
        {data.meta.tags.map((tag) => (
          <Badge key={tag} variant="muted">
            {tag}
          </Badge>
        ))}
      </div>

      {data.modelBundle && (
        <Link
          href={`/models/${data.modelBundle.name}`}
          className="flex items-center gap-3 rounded-[24px] border border-accent/20 bg-accent/10 p-4 transition-colors hover:bg-accent/15"
        >
          <div className="flex-1">
            <div className="text-sm font-medium text-accent">Pre-built model bundle available</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {data.modelBundle.displayName} with {data.modelBundle.martCount} mart
              {data.modelBundle.martCount !== 1 ? 's' : ''} ready to browse.
            </div>
          </div>
          <span className="text-xs text-accent">Open →</span>
        </Link>
      )}

      {data.meta.auth_setup && data.meta.auth_setup.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Authentication Setup</h2>
            <div className="flex items-center gap-2">
              <Link
                href={`/integrations/${data.name}/setup`}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                Setup Guide
              </Link>
              <button
                type="button"
                onClick={() => void runHealthCheck('extract', ['health-check', data.name])}
                disabled={healthChecking}
                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50"
              >
                {healthChecking ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
          </div>
          <div className="divide-y divide-border rounded-2xl border border-border bg-card">
            {data.meta.auth_setup.map((entry) => (
              <div key={entry.env} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                    {entry.env}
                  </code>
                  {entry.docs_url && (
                    <a
                      href={entry.docs_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-primary hover:underline"
                    >
                      setup docs
                    </a>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{entry.description}</p>
              </div>
            ))}
          </div>

          {(healthChecking ||
            healthOutputs.length > 0 ||
            healthError ||
            healthExitCode !== null) && (
            <div className="rounded-2xl border border-border bg-card p-4">
              {healthChecking && (
                <div className="text-xs text-muted-foreground">Running health check...</div>
              )}
              {!healthChecking && healthStatus.status === 'connected' && (
                <div className="text-xs text-accent">Connected successfully.</div>
              )}
              {!healthChecking && healthStatus.status === 'missing_env' && (
                <div className="space-y-2 text-xs text-warning">
                  <div>Missing environment variables:</div>
                  <div className="flex flex-wrap gap-2">
                    {healthStatus.missingVars.map((entry) => (
                      <code key={entry} className="rounded-md bg-warning/10 px-2 py-1">
                        {entry}
                      </code>
                    ))}
                  </div>
                </div>
              )}
              {!healthChecking && healthStatus.status === 'failed' && (
                <div className="text-xs text-destructive">
                  {healthStatus.error ?? 'Connection test failed.'}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Resources</h2>
          <span className="text-[10px] text-muted-foreground">
            Showing {filteredResources.length} of {data.resources.length} resource
            {data.resources.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            aria-label="Search resources"
            value={resourceSearch}
            onChange={(event) => setResourceSearch(event.target.value)}
            placeholder="Search resources..."
            className="w-64 rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            aria-pressed={incrementalOnly}
            onClick={() => setIncrementalOnly((value) => !value)}
            className={`rounded-full border px-3 py-1 text-[10px] transition-colors ${
              incrementalOnly
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-primary/30'
            }`}
          >
            Incremental only
          </button>
          <button
            type="button"
            aria-pressed={billableOnly}
            onClick={() => setBillableOnly((value) => !value)}
            className={`rounded-full border px-3 py-1 text-[10px] transition-colors ${
              billableOnly
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-primary/30'
            }`}
          >
            Billable
          </button>
        </div>
        <div className="space-y-2">
          {filteredResources.map((resource) => (
            <ResourceDetail key={resource.name} collapseKey={collapseKey} resource={resource} />
          ))}
          {filteredResources.length === 0 && (
            <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
              No resources match the current filters.
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <Link
          href={`/pipelines/new?integration=${data.name}&step=resources`}
          className="rounded-[24px] border border-border bg-card p-4 transition-colors hover:border-primary/50"
        >
          <div className="text-sm font-medium">Build a pipeline with this integration</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Start the pipeline builder with {data.meta.display_name} preselected so you can jump
            straight to resources.
          </p>
        </Link>

        {data.modelBundle && (
          <Link
            href={`/models/${data.modelBundle.name}`}
            className="rounded-[24px] border border-border bg-card p-4 transition-colors hover:border-primary/50"
          >
            <div className="text-sm font-medium">Explore the model bundle</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Compare the extractor schema to the analytics marts built on top of it.
            </p>
          </Link>
        )}
      </section>
    </div>
  );
}
