'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { buildTerminalHref } from '@/lib/command-links';
import {
  buildPipelineRunArgs,
  isPipelineConfig,
  type PipelineConfig,
  generateDogsledYml,
} from '@/lib/pipelineExport';
import { generateCliCommands } from '@/lib/pipeline-export-content';
import {
  isPipelineValidationResult,
  type PipelineValidationResult,
} from '@/lib/pipeline-validation';

type ExportFormat = 'dogsled-yml' | 'cli-commands';

const EXPORT_FORMATS: Array<{ id: ExportFormat; name: string; description: string }> = [
  { id: 'dogsled-yml', name: 'dogsled.yml', description: 'Local pipeline configuration' },
  { id: 'cli-commands', name: 'CLI Commands', description: 'Commands for manual execution' },
];

const DEMO_CONFIG: PipelineConfig = {
  selectedIntegrations: ['stripe', 'hubspot'],
  resources: {
    stripe: ['customers', 'subscriptions', 'invoices'],
    hubspot: ['contacts', 'companies', 'deals'],
  },
  destination: { type: 'duckdb', db_path: './pipeline.duckdb' },
  schedule: 'every 4h',
};

function ExportPageInner() {
  const searchParams = useSearchParams();
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('dogsled-yml');
  const [copied, setCopied] = useState(false);
  const encodedConfig = searchParams.get('config');
  const { config, fromBuilder } = useMemo<{ config: PipelineConfig; fromBuilder: boolean }>(() => {
    if (!encodedConfig) {
      return { config: DEMO_CONFIG, fromBuilder: false };
    }
    try {
      const decoded: unknown = JSON.parse(atob(encodedConfig));
      if (isPipelineConfig(decoded)) {
        return { config: decoded, fromBuilder: true };
      }
    } catch {
      // Fall back to demo config.
    }
    return { config: DEMO_CONFIG, fromBuilder: false };
  }, [encodedConfig]);

  const encodedValidation = searchParams.get('validation');
  const validation = useMemo<PipelineValidationResult | null>(() => {
    if (!encodedValidation) {
      return null;
    }
    try {
      const decoded: unknown = JSON.parse(atob(encodedValidation));
      return isPipelineValidationResult(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }, [encodedValidation]);

  const content =
    selectedFormat === 'dogsled-yml' ? generateDogsledYml(config) : generateCliCommands(config);

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/pipelines/new" className="hover:text-foreground">
          Create New
        </Link>
        <span>/</span>
        <span className="text-foreground">Export</span>
      </div>

      <div>
        <h1 className="text-xl font-bold tracking-tight">Export Pipeline</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {fromBuilder
            ? 'Export your pipeline configuration or local CLI commands.'
            : 'Showing demo configuration — build a pipeline first for your own config'}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          Configuration Summary
        </div>
        <div className="grid grid-cols-3 gap-4 text-xs">
          <div>
            <div className="text-[10px] text-muted-foreground">Sources</div>
            <div className="font-medium">
              {config.selectedIntegrations
                .map((integration) => integration.replace(/_/g, ' '))
                .join(', ')}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">Destination</div>
            <div className="font-medium capitalize">{config.destination.type}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">Schedule</div>
            <div className="font-medium">{config.schedule}</div>
          </div>
        </div>
      </div>

      {!fromBuilder && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
          <p className="text-xs text-warning">
            This is a demo configuration.{' '}
            <Link href="/pipelines/new" className="font-medium underline">
              Build your own pipeline
            </Link>{' '}
            to export your config.
          </p>
        </div>
      )}

      {validation && (
        <div
          className={`rounded-lg border px-4 py-3 ${
            validation.valid ? 'border-accent/30 bg-accent/10' : 'border-warning/30 bg-warning/10'
          }`}
        >
          <div
            className={`text-xs font-medium ${validation.valid ? 'text-accent' : 'text-warning'}`}
          >
            {validation.valid ? 'Validation passed' : 'Validation needs attention'}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Schedule: {validation.scheduleMessage}
          </div>
          {validation.warnings.length > 0 && (
            <div className="mt-2 text-[11px] text-warning">{validation.warnings.join(' • ')}</div>
          )}
          {validation.errors.length > 0 && (
            <div className="mt-2 text-[11px] text-destructive">{validation.errors.join(' • ')}</div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {EXPORT_FORMATS.map((format) => (
          <button
            key={format.id}
            type="button"
            onClick={() => setSelectedFormat(format.id)}
            className={`rounded-lg border px-3 py-2 text-xs transition-colors ${
              selectedFormat === format.id
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card hover:border-primary/30'
            }`}
          >
            <div className="font-medium">{format.name}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{format.description}</div>
          </button>
        ))}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {EXPORT_FORMATS.find((format) => format.id === selectedFormat)?.name}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="text-[10px] text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
          >
            {copied ? 'Copied!' : 'Copy to clipboard'}
          </button>
        </div>
        <pre className="max-h-[500px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-card p-4 font-mono text-[11px]">
          {content}
        </pre>
      </div>

      <div className="flex gap-3">
        <Link
          href="/pipelines/new"
          className="rounded-md border border-border px-4 py-2 text-xs text-muted-foreground hover:bg-secondary"
        >
          Back to Builder
        </Link>
        <Link
          href={buildTerminalHref(buildPipelineRunArgs(config))}
          className="rounded-md bg-accent px-4 py-2 text-xs text-white hover:bg-accent/80"
        >
          Run in Terminal
        </Link>
      </div>
    </div>
  );
}

export default function ExportPage() {
  return (
    <Suspense fallback={<div className="p-6 text-xs text-muted-foreground">Loading...</div>}>
      <ExportPageInner />
    </Suspense>
  );
}
