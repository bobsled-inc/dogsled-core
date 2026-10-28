'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { summarizeHealthCheck } from '@/lib/command-insights';
import { buildTerminalHref } from '@/lib/command-links';
import { parseIntegrationDetail, type IntegrationDetail } from '@/lib/integration-detail';
import { buildPipelineCliArgs } from '@/lib/pipelineExport';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { SyntaxBlock } from '@/components/ui/syntax-block';
import { useCommand } from '@/lib/use-command';

export default function IntegrationSetupGuidePage() {
  const params = useParams();
  const nameParam = Array.isArray(params.name) ? params.name[0] : params.name;
  const name = typeof nameParam === 'string' && nameParam.length > 0 ? nameParam : null;
  const [data, setData] = useState<IntegrationDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const { running, outputs, exitCode, error, run } = useCommand();

  useEffect(() => {
    if (!name) {
      setData(null);
      setErrorMessage('Integration route is invalid.');
      return;
    }

    const controller = new AbortController();
    setData(null);
    setErrorMessage(null);

    fetch(`/api/integrations/${name}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Integration "${name}" not found`);
        }
        return response.json();
      })
      .then((payload: unknown) => {
        const detail = parseIntegrationDetail(payload);
        if (!detail) {
          throw new Error(`Integration "${name}" returned an invalid payload.`);
        }
        setData(detail);
        setSelectedResources(detail.resources.slice(0, 3).map((resource) => resource.name));
        setErrorMessage(null);
      })
      .catch((err) => {
        if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
          return;
        }
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load setup guide.');
      });

    return () => controller.abort();
  }, [name]);

  const copyEnvSnippet = (envName: string) => {
    void navigator.clipboard.writeText(`export ${envName}=your_value_here`).catch(() => {});
  };

  const healthStatus = summarizeHealthCheck(outputs, exitCode, error);
  const commandArgs = useMemo(() => {
    return buildPipelineCliArgs({
      integration: data?.name ?? '',
      resources: selectedResources,
      destination: { type: 'duckdb', db_path: './pipeline.duckdb' },
    });
  }, [data?.name, selectedResources]);
  const commandText = `dogsled pipeline ${commandArgs.join(' ')}`;

  if (errorMessage) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <PageHeader
          title="Setup guide unavailable"
          description={errorMessage}
          breadcrumbs={[
            { label: 'Integrations', href: '/integrations' },
            { label: 'Missing Integration' },
            { label: 'Setup Guide' },
          ]}
        />
        <Link href="/integrations" className="text-sm text-primary hover:underline">
          Back to Integrations
        </Link>
      </div>
    );
  }

  if (!data) {
    return <div className="p-6 text-xs text-muted-foreground">Loading setup guide...</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        title={`${data.meta.display_name} Setup Guide`}
        description="Move from prerequisites to a runnable local pipeline without leaving Explorer."
        breadcrumbs={[
          { label: 'Integrations', href: '/integrations' },
          { label: data.meta.display_name, href: `/integrations/${data.name}` },
          { label: 'Setup Guide' },
        ]}
      />

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Step 1</div>
        <h2 className="mt-2 text-sm font-semibold">Prerequisites</h2>
        <div className="mt-4 space-y-3">
          {(data.meta.auth_setup ?? []).map((entry) => (
            <div key={entry.env} className="rounded-2xl border border-border bg-secondary/30 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
                  {entry.env}
                </code>
                <button
                  type="button"
                  onClick={() => copyEnvSnippet(entry.env)}
                  className="text-[10px] text-primary hover:underline"
                >
                  Copy export snippet
                </button>
                {entry.docs_url && (
                  <a
                    href={entry.docs_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-primary hover:underline"
                  >
                    Where to find it
                  </a>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{entry.description}</p>
            </div>
          ))}

          {data.meta.docs_url && (
            <a
              href={data.meta.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex text-xs text-primary hover:underline"
            >
              Open docs
            </a>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Step 2</div>
        <h2 className="mt-2 text-sm font-semibold">Test Connection</h2>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void run('extract', ['health-check', data.name])}
            disabled={running}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50"
          >
            {running ? 'Testing...' : 'Run health check'}
          </button>
          {healthStatus.status === 'connected' && <Badge variant="success">Connected</Badge>}
          {healthStatus.status === 'missing_env' && (
            <Badge variant="warning">Missing env vars</Badge>
          )}
          {healthStatus.status === 'failed' && <Badge variant="warning">Needs attention</Badge>}
        </div>
        {(outputs.length > 0 || error || exitCode !== null) && (
          <div className="mt-4 rounded-2xl border border-border bg-secondary/30 p-4 text-xs">
            {healthStatus.status === 'missing_env' && (
              <div className="text-warning">Missing: {healthStatus.missingVars.join(', ')}</div>
            )}
            {healthStatus.status === 'failed' && (
              <div className="text-destructive">{healthStatus.error ?? 'Health check failed.'}</div>
            )}
            {healthStatus.status === 'connected' && (
              <div className="text-accent">Health check passed.</div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Step 3</div>
        <h2 className="mt-2 text-sm font-semibold">Choose Resources</h2>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.resources.map((resource) => (
            <button
              key={resource.name}
              type="button"
              onClick={() =>
                setSelectedResources((previous) =>
                  previous.includes(resource.name)
                    ? previous.filter((entry) => entry !== resource.name)
                    : [...previous, resource.name]
                )
              }
              className={`rounded-2xl border p-3 text-left text-xs transition-colors ${
                selectedResources.includes(resource.name)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-secondary/20 hover:border-primary/40'
              }`}
            >
              <div className="font-medium">{resource.name}</div>
              {resource.description && (
                <div className="mt-1 text-[10px] text-muted-foreground">{resource.description}</div>
              )}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Step 4</div>
        <h2 className="mt-2 text-sm font-semibold">Generate Command</h2>
        <div className="mt-4">
          <SyntaxBlock code={commandText} language="bash" />
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Step 5</div>
        <h2 className="mt-2 text-sm font-semibold">Run</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Open Terminal with the generated command preloaded so you can execute immediately.
        </p>
        <Link
          href={buildTerminalHref({ command: 'pipeline', args: commandArgs })}
          className="mt-4 inline-flex rounded-md bg-accent px-4 py-2 text-xs text-accent-foreground transition-colors hover:bg-accent/85"
        >
          Open in Terminal
        </Link>
      </section>
    </div>
  );
}
