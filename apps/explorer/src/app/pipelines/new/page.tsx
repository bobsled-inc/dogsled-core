'use client';

import { explorerFetch } from '@/lib/explorer-fetch';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { buildTerminalHref } from '@/lib/command-links';
import {
  buildPipelineRunArgs,
  generateDogsledYml,
  isPipelineConfig,
  type PipelineConfig,
} from '@/lib/pipelineExport';
import {
  isPipelineValidationResult,
  type PipelineValidationResult,
} from '@/lib/pipeline-validation';
import {
  encodePipelineConfig,
  encodePipelineValidation,
  PIPELINE_DRAFT_STORAGE_KEY,
} from '@/lib/pipeline-draft';
import { parseSchedule } from '@/lib/schedule-utils';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { StepIndicator } from '@/components/ui/step-indicator';

interface IntegrationSummary {
  name: string;
  display_name: string;
  category: string;
  description?: string;
  auth_type?: string;
  resource_count: number;
  integration_type: string;
}

interface ResourceSpec {
  name: string;
  description?: string;
  extract?: { incremental?: { cursor_field?: string } };
}

type WizardStep = 'preset' | 'integrations' | 'resources' | 'destination' | 'schedule' | 'review';

const PRESETS = [
  {
    id: 'saas-analytics',
    name: 'SaaS Analytics',
    description: 'Stripe + HubSpot + GitHub to DuckDB',
    integrations: ['stripe', 'hubspot', 'github'],
    schedule: 'every 4h',
  },
  {
    id: 'customer-ops',
    name: 'Customer Ops',
    description: 'HubSpot + Pylon + Slack',
    integrations: ['hubspot', 'pylon', 'slack'],
    schedule: 'every 4h',
  },
  {
    id: 'revenue-ops',
    name: 'Revenue Ops',
    description: 'HubSpot + Smartlead + Stripe',
    integrations: ['hubspot', 'smartlead', 'stripe'],
    schedule: 'daily',
  },
  {
    id: 'product-delivery',
    name: 'Product Delivery',
    description: 'GitHub + GitLab + Linear',
    integrations: ['github', 'gitlab', 'linear'],
    schedule: 'every 4h',
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Choose your own integrations',
    integrations: [],
    schedule: 'daily',
  },
] as const;

const DESTINATIONS = [
  {
    type: 'duckdb',
    name: 'DuckDB',
    description: 'Local analytics database',
    fields: { db_path: './pipeline.duckdb' },
  },
  {
    type: 'bigquery',
    name: 'BigQuery',
    description: 'Google Cloud data warehouse',
    fields: { project: '', dataset: '' },
  },
  { type: 'snowflake', name: 'Snowflake', description: 'Cloud data platform', fields: {} },
  { type: 'postgres', name: 'PostgreSQL', description: 'Relational database', fields: {} },
  {
    type: 'clickhouse',
    name: 'ClickHouse',
    description: 'Column-oriented OLAP database',
    fields: { host: '', database: '' },
  },
  {
    type: 'turbopuffer',
    name: 'Turbopuffer',
    description: 'Serverless vector search',
    fields: { region: 'gcp-us-central1', namespace_prefix: '' },
  },
  {
    type: 'local',
    name: 'Local Files',
    description: 'JSONL/CSV/Parquet files',
    fields: { prefix: './data' },
  },
  { type: 's3', name: 'S3', description: 'AWS object storage', fields: { bucket: '', prefix: '' } },
  {
    type: 'gcs',
    name: 'GCS',
    description: 'Google Cloud Storage',
    fields: { bucket: '', prefix: '' },
  },
] as const;

const DEFAULT_CONFIG: PipelineConfig = {
  selectedIntegrations: [],
  resources: {},
  destination: { type: 'duckdb', db_path: './pipeline.duckdb' },
  schedule: 'daily',
};

function isWizardStep(value: string | null): value is WizardStep {
  return (
    value === 'preset' ||
    value === 'integrations' ||
    value === 'resources' ||
    value === 'destination' ||
    value === 'schedule' ||
    value === 'review'
  );
}

function applyPresetConfig(presetId: string, currentConfig: PipelineConfig): PipelineConfig {
  const preset = PRESETS.find((item) => item.id === presetId);
  if (!preset) return currentConfig;

  return {
    selectedIntegrations: [...preset.integrations],
    resources: Object.fromEntries(
      preset.integrations.map((integration) => [
        integration,
        currentConfig.resources[integration] ?? [],
      ])
    ),
    destination: { type: 'duckdb', db_path: './pipeline.duckdb' },
    schedule: preset.schedule,
  };
}

function normalizeConfig(value: unknown): PipelineConfig {
  if (!isPipelineConfig(value)) return DEFAULT_CONFIG;

  const destination = value.destination;
  return {
    selectedIntegrations: value.selectedIntegrations.filter(
      (integration): integration is string => typeof integration === 'string'
    ),
    resources:
      typeof value.resources === 'object' && value.resources !== null
        ? Object.fromEntries(
            Object.entries(value.resources).map(([integration, resources]) => [
              integration,
              Array.isArray(resources)
                ? resources.filter((resource): resource is string => typeof resource === 'string')
                : [],
            ])
          )
        : {},
    destination: {
      type: destination.type,
      db_path: destination.db_path,
      project: destination.project,
      dataset: destination.dataset,
      bucket: destination.bucket,
      prefix: destination.prefix,
    },
    schedule: value.schedule,
  };
}

function getPersistedWizardState(): { config: PipelineConfig; step: WizardStep } {
  try {
    const raw = window.localStorage.getItem(PIPELINE_DRAFT_STORAGE_KEY);
    if (!raw) return { config: DEFAULT_CONFIG, step: 'preset' };
    const parsed = JSON.parse(raw) as { config?: unknown; step?: string };
    const persistedStep = typeof parsed.step === 'string' ? parsed.step : null;
    return {
      config: normalizeConfig(parsed.config),
      step: isWizardStep(persistedStep) ? persistedStep : 'preset',
    };
  } catch {
    return { config: DEFAULT_CONFIG, step: 'preset' };
  }
}

export default function NewPipelinePage() {
  const [step, setStep] = useState<WizardStep>('preset');
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [resourcesByIntegration, setResourcesByIntegration] = useState<
    Record<string, ResourceSpec[] | 'loading' | 'failed'>
  >({});
  const [config, setConfig] = useState<PipelineConfig>(DEFAULT_CONFIG);
  const requestedResources = useRef(new Set<string>());
  const [hydrated, setHydrated] = useState(false);
  const [validationResult, setValidationResult] = useState<PipelineValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    explorerFetch('/api/integrations')
      .then((response) => response.json())
      .then((data: { integrations: IntegrationSummary[] }) => setIntegrations(data.integrations))
      .catch(() => {});
  }, []);

  const loadResources = useCallback(async (name: string) => {
    if (requestedResources.current.has(name)) return;
    requestedResources.current.add(name);
    setResourcesByIntegration((previous) => ({ ...previous, [name]: 'loading' }));

    try {
      const response = await explorerFetch(`/api/integrations/${name}`);
      if (!response.ok) {
        requestedResources.current.delete(name);
        setResourcesByIntegration((previous) => ({ ...previous, [name]: 'failed' }));
        return;
      }
      const data = (await response.json()) as { resources: ResourceSpec[] };
      setResourcesByIntegration((previous) => ({ ...previous, [name]: data.resources }));
    } catch {
      requestedResources.current.delete(name);
      setResourcesByIntegration((previous) => ({ ...previous, [name]: 'failed' }));
    }
  }, []);

  useEffect(() => {
    const persisted = getPersistedWizardState();
    let nextConfig = persisted.config;
    let nextStep = persisted.step;

    const searchParams = new URLSearchParams(window.location.search);
    const presetId = searchParams.get('preset');
    const integration = searchParams.get('integration');
    const requestedStep = searchParams.get('step');

    if (presetId) {
      nextConfig = applyPresetConfig(presetId, nextConfig);
      nextStep = 'integrations';
    }

    if (integration) {
      nextConfig = {
        ...nextConfig,
        selectedIntegrations: [integration],
        resources: {
          ...nextConfig.resources,
          [integration]: nextConfig.resources[integration] ?? [],
        },
      };
      nextStep = 'resources';
    }

    if (isWizardStep(requestedStep)) {
      nextStep = requestedStep;
    }

    setConfig(nextConfig);
    setStep(nextStep);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(PIPELINE_DRAFT_STORAGE_KEY, JSON.stringify({ config, step }));
  }, [config, step, hydrated]);

  useEffect(() => {
    setValidationResult(null);
  }, [config]);

  useEffect(() => {
    if (step === 'preset') return;
    config.selectedIntegrations.forEach((integrationName) => {
      void loadResources(integrationName);
    });
  }, [config.selectedIntegrations, loadResources, step]);

  const toggleIntegration = (name: string) => {
    setConfig((previous) => {
      const selectedIntegrations = previous.selectedIntegrations.includes(name)
        ? previous.selectedIntegrations.filter((integration) => integration !== name)
        : [...previous.selectedIntegrations, name];

      return {
        ...previous,
        selectedIntegrations,
        resources: selectedIntegrations.includes(name)
          ? previous.resources
          : Object.fromEntries(
              Object.entries(previous.resources).filter(([integration]) => integration !== name)
            ),
      };
    });
  };

  const toggleResource = (integration: string, resource: string) => {
    setConfig((previous) => {
      const currentResources = previous.resources[integration] ?? [];
      const nextResources = currentResources.includes(resource)
        ? currentResources.filter((item) => item !== resource)
        : [...currentResources, resource];

      return {
        ...previous,
        resources: {
          ...previous.resources,
          [integration]: nextResources,
        },
      };
    });
  };

  const resetBuilder = () => {
    window.localStorage.removeItem(PIPELINE_DRAFT_STORAGE_KEY);
    requestedResources.current.clear();
    setResourcesByIntegration({});
    setConfig(DEFAULT_CONFIG);
    setStep('preset');
  };

  const steps: { key: WizardStep; label: string }[] = [
    { key: 'preset', label: 'Preset' },
    { key: 'integrations', label: 'Sources' },
    { key: 'resources', label: 'Resources' },
    { key: 'destination', label: 'Destination' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'review', label: 'Review' },
  ];
  const stepIndex = steps.findIndex((wizardStep) => wizardStep.key === step);
  const encodedConfig = encodePipelineConfig(config);
  const encodedValidation = validationResult ? encodePipelineValidation(validationResult) : '';
  const scheduleValidation = parseSchedule(config.schedule);

  const validatePipeline = async () => {
    setValidating(true);
    setValidationError(null);
    try {
      const response = await explorerFetch('/api/pipelines/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          typeof payload.error === 'string'
            ? payload.error
            : 'Pipeline validation failed.';
        setValidationResult(null);
        setValidationError(message);
        return;
      }

      if (!isPipelineValidationResult(payload)) {
        setValidationResult(null);
        setValidationError('Pipeline validation returned an unexpected response.');
        return;
      }

      setValidationResult(payload);
      setValidationError(null);
    } catch {
      setValidationResult(null);
      setValidationError('Pipeline validation request failed.');
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        breadcrumbs={[{ label: 'Create Pipeline' }]}
        title="Create Pipeline"
        description="Configure an extract + load pipeline, keep the state across refreshes, and hand the resulting command off to Terminal."
      />

      <StepIndicator
        steps={steps}
        currentIndex={stepIndex}
        onStepClick={(index) => {
          const nextStep = steps[index];
          setStep(nextStep ? nextStep.key : 'preset');
        }}
      />

      {step === 'preset' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Choose a starting point</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setConfig(applyPresetConfig(preset.id, DEFAULT_CONFIG));
                  setStep('integrations');
                }}
                className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 hover:shadow-sm hover:shadow-primary/5"
              >
                <div className="text-sm font-medium">{preset.name}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">{preset.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 'integrations' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Select data sources</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {integrations.map((integration) => (
              <div key={integration.name} className="group relative">
                <button
                  type="button"
                  onClick={() => toggleIntegration(integration.name)}
                  className={`w-full rounded-2xl border p-3 text-left text-xs transition-colors ${
                    config.selectedIntegrations.includes(integration.name)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm hover:shadow-primary/5'
                  }`}
                >
                  <div className="font-medium">{integration.display_name}</div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <Badge variant="primary">{integration.resource_count} resources</Badge>
                    {integration.auth_type && <Badge>{integration.auth_type}</Badge>}
                  </div>
                </button>
                <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-64 -translate-x-1/2 rounded-2xl border border-border bg-card p-3 text-[10px] text-muted-foreground shadow-lg group-hover:block">
                  <div className="text-xs font-medium text-foreground">
                    {integration.display_name}
                  </div>
                  <p className="mt-2 leading-5">
                    {integration.description ?? 'No description available.'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge>{integration.category.replace(/_/g, ' ')}</Badge>
                    <Badge variant="primary">{integration.resource_count} resources</Badge>
                    {integration.auth_type && (
                      <Badge variant="accent">{integration.auth_type}</Badge>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setStep('resources')}
              disabled={config.selectedIntegrations.length === 0}
              className="rounded-md bg-primary px-4 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next: Pick Resources
            </button>
          </div>
        </div>
      )}

      {step === 'resources' && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold">Select resources to extract</h2>
          {config.selectedIntegrations.map((integration) => {
            const resourceState = resourcesByIntegration[integration];
            const resourceList = Array.isArray(resourceState) ? resourceState : [];
            const selectedResources = config.resources[integration] ?? [];

            return (
              <div key={integration} className="rounded-2xl border border-border bg-card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="text-xs font-semibold capitalize">
                      {integration.replace(/_/g, ' ')}
                    </h3>
                    <Link
                      href={`/integrations/${integration}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-primary hover:underline"
                    >
                      View integration →
                    </Link>
                  </div>
                  {Array.isArray(resourceState) && resourceList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const allResources = resourceList.map((resource) => resource.name);
                        setConfig((previous) => ({
                          ...previous,
                          resources: {
                            ...previous.resources,
                            [integration]:
                              selectedResources.length === allResources.length ? [] : allResources,
                          },
                        }));
                      }}
                      className="text-[10px] text-primary hover:underline"
                    >
                      {selectedResources.length === resourceList.length
                        ? 'Deselect all'
                        : 'Select all'}
                    </button>
                  )}
                </div>

                {resourceState === 'loading' || resourceState === undefined ? (
                  <div className="text-[10px] text-muted-foreground">Loading resources...</div>
                ) : resourceState === 'failed' ? (
                  <div className="text-[10px] text-destructive">Failed to load resources</div>
                ) : resourceList.length === 0 ? (
                  <div className="text-[10px] text-muted-foreground">No resources available</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {resourceList.map((resource) => (
                      <button
                        key={resource.name}
                        type="button"
                        onClick={() => toggleResource(integration, resource.name)}
                        className={`rounded px-2 py-1.5 text-left text-[10px] transition-colors ${
                          selectedResources.includes(resource.name)
                            ? 'bg-primary/10 text-primary'
                            : 'bg-secondary text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {resource.name}
                        {resource.extract?.incremental && (
                          <span className="ml-1 text-accent">~</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep('integrations')}
              className="rounded-md border border-border px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep('destination')}
              className="rounded-md bg-primary px-4 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary/85"
            >
              Next: Destination
            </button>
          </div>
        </div>
      )}

      {step === 'destination' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Choose a destination</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {DESTINATIONS.map((destination) => (
              <button
                key={destination.type}
                type="button"
                onClick={() =>
                  setConfig((previous) => ({
                    ...previous,
                    destination: { type: destination.type, ...destination.fields },
                  }))
                }
                className={`rounded-2xl border p-3 text-left transition-colors ${
                  config.destination.type === destination.type
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card hover:border-primary/30'
                }`}
              >
                <div className="text-xs font-medium">{destination.name}</div>
                <div className="text-[10px] text-muted-foreground">{destination.description}</div>
              </button>
            ))}
          </div>

          {config.destination.type === 'duckdb' && (
            <div>
              <label className="text-[10px] text-muted-foreground">Database path</label>
              <input
                value={config.destination.db_path ?? './pipeline.duckdb'}
                onChange={(event) =>
                  setConfig((previous) => ({
                    ...previous,
                    destination: { ...previous.destination, db_path: event.target.value },
                  }))
                }
                className="mt-1 w-64 rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {config.destination.type === 'bigquery' && (
            <div className="flex gap-3">
              <div>
                <label className="text-[10px] text-muted-foreground">Project</label>
                <input
                  value={config.destination.project ?? ''}
                  onChange={(event) =>
                    setConfig((previous) => ({
                      ...previous,
                      destination: { ...previous.destination, project: event.target.value },
                    }))
                  }
                  className="mt-1 w-48 rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="my-project"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">Dataset</label>
                <input
                  value={config.destination.dataset ?? ''}
                  onChange={(event) =>
                    setConfig((previous) => ({
                      ...previous,
                      destination: { ...previous.destination, dataset: event.target.value },
                    }))
                  }
                  className="mt-1 w-48 rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="raw_data"
                />
              </div>
            </div>
          )}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep('resources')}
              className="rounded-md border border-border px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep('schedule')}
              className="rounded-md bg-primary px-4 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary/85"
            >
              Next: Schedule
            </button>
          </div>
        </div>
      )}

      {step === 'schedule' && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Set extraction schedule</h2>
          <div className="flex flex-wrap gap-2">
            {['hourly', 'every 4h', 'daily', 'weekly'].map((schedule) => (
              <button
                key={schedule}
                type="button"
                onClick={() => setConfig((previous) => ({ ...previous, schedule }))}
                className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                  config.schedule === schedule
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:border-primary/30'
                }`}
              >
                {schedule}
              </button>
            ))}
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground">Custom schedule</label>
            <input
              value={config.schedule}
              onChange={(event) =>
                setConfig((previous) => ({ ...previous, schedule: event.target.value }))
              }
              className="mt-1 w-48 rounded-md border border-border bg-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {scheduleValidation.valid ? (
            <div className="rounded-2xl border border-accent/20 bg-accent/10 p-4">
              <div className="text-xs font-medium text-accent">
                {scheduleValidation.human} ({scheduleValidation.cron})
              </div>
              {scheduleValidation.nextRuns && scheduleValidation.nextRuns.length > 0 && (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Runs at: {scheduleValidation.nextRuns.join(', ')}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-4 text-xs text-destructive">
              {scheduleValidation.error}
            </div>
          )}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep('destination')}
              className="rounded-md border border-border px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep('review')}
              className="rounded-md bg-primary px-4 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary/85"
            >
              Review
            </button>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Review Pipeline Configuration</h2>
            <button
              type="button"
              onClick={resetBuilder}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear Config
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Sources
              </div>
              {config.selectedIntegrations.map((integration) => (
                <div key={integration} className="text-xs">
                  <div>
                    <span className="font-medium capitalize">{integration.replace(/_/g, ' ')}</span>
                    {(config.resources[integration] ?? []).length > 0 && (
                      <span className="ml-1 text-muted-foreground">
                        ({config.resources[integration]?.length} resources)
                      </span>
                    )}
                  </div>
                  <Link
                    href={`/integrations/${integration}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-primary hover:underline"
                  >
                    Browse {integration.replace(/_/g, ' ')} resources →
                  </Link>
                </div>
              ))}
            </div>

            <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Destination
              </div>
              <div className="text-xs font-medium capitalize">{config.destination.type}</div>
              {config.destination.db_path && (
                <div className="text-[10px] text-muted-foreground">
                  {config.destination.db_path}
                </div>
              )}
              <div className="pt-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Schedule
              </div>
              <div className="text-xs">{config.schedule}</div>
              {scheduleValidation.valid && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {scheduleValidation.human}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Generated dogsled.yml
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void validatePipeline()}
                  disabled={validating}
                  className="text-[10px] text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {validating ? 'Validating...' : 'Validate Pipeline'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(generateDogsledYml(config)).catch(() => {});
                  }}
                  className="text-[10px] text-primary hover:underline"
                >
                  Copy
                </button>
                <Link
                  href={`/pipelines/new/export?config=${encodedConfig}${encodedValidation ? `&validation=${encodedValidation}` : ''}`}
                  className="text-[10px] text-primary hover:underline"
                >
                  Export Options
                </Link>
              </div>
            </div>

            <pre className="max-h-96 overflow-auto rounded-2xl border border-border bg-card p-4 font-mono text-[11px] whitespace-pre-wrap">
              {generateDogsledYml(config)}
            </pre>
          </div>

          {validationError && (
            <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-4 text-xs text-destructive">
              {validationError}
            </div>
          )}

          {validationResult && (
            <div
              className={`rounded-2xl border p-4 ${
                validationResult.valid
                  ? 'border-accent/20 bg-accent/10'
                  : 'border-warning/20 bg-warning/10'
              }`}
            >
              <div
                className={`text-sm font-medium ${
                  validationResult.valid ? 'text-accent' : 'text-warning'
                }`}
              >
                {validationResult.valid ? 'Validation passed' : 'Fix before running'}
              </div>
              <div className="mt-3 space-y-2 text-xs">
                <div>
                  ✓ Schedule:{' '}
                  <span className="text-muted-foreground">{validationResult.scheduleMessage}</span>
                </div>
                <div>
                  {validationResult.destinationValid ? '✓' : '✕'} Destination type:{' '}
                  <span className="text-muted-foreground">{validationResult.destinationType}</span>
                </div>
                {validationResult.integrations.map((integration) => (
                  <div
                    key={integration.name}
                    className="rounded-xl border border-border/60 bg-card/60 p-3"
                  >
                    <div className="font-medium">
                      {integration.valid ? '✓' : '⚠'} {integration.name}
                    </div>
                    {integration.resourcesFound.length > 0 && (
                      <div className="mt-1 text-muted-foreground">
                        Resources exist: {integration.resourcesFound.join(', ')}
                      </div>
                    )}
                    {integration.missingVars.length > 0 && (
                      <div className="mt-1 text-warning">
                        Missing env vars: {integration.missingVars.join(', ')}
                      </div>
                    )}
                    {integration.unknownResources.length > 0 && (
                      <div className="mt-1 text-destructive">
                        Unknown resources: {integration.unknownResources.join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep('schedule')}
              className="rounded-md border border-border px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary"
            >
              Back
            </button>
            <Link
              href={buildTerminalHref(buildPipelineRunArgs(config))}
              className="rounded-md bg-accent px-4 py-2 text-xs text-accent-foreground transition-colors hover:bg-accent/85"
            >
              Run in Terminal
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
