import { NextResponse } from 'next/server';
import type { AuthSetupEntry } from '@bobsled-inc/integrations';
import { integrationsBatched, withIntegrationCache } from '@/lib/integrations';
import { isPipelineConfig } from '@/lib/pipelineExport';
import type { PipelineValidationResult } from '@/lib/pipeline-validation';
import { parseSchedule } from '@/lib/schedule-utils';

const VALID_DESTINATIONS = new Set([
  'duckdb',
  'bigquery',
  'snowflake',
  'postgres',
  'clickhouse',
  'turbopuffer',
  'local',
  's3',
  'gcs',
]);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { config?: unknown };
    const config = body.config;

    if (!isPipelineConfig(config)) {
      return NextResponse.json({ error: 'Invalid pipeline config' }, { status: 400 });
    }

    const schedule = parseSchedule(config.schedule);
    const destinationValid = VALID_DESTINATIONS.has(config.destination.type);
    const integrations = await withIntegrationCache(() =>
      config.selectedIntegrations.map((integrationName) => {
        try {
          const integration = integrationsBatched.get(integrationName);
          const resources = integrationsBatched
            .getResources(integrationName)
            .map((entry) => entry.resource.name);
          const selectedResources = config.resources[integrationName] ?? [];
          const unknownResources = selectedResources.filter(
            (resource) => !resources.includes(resource)
          );
          const missingVars = (integration.meta.auth_setup ?? [])
            .map((entry: AuthSetupEntry) => entry.env)
            .filter((envName) => !process.env[envName]);

          return {
            name: integrationName,
            valid: unknownResources.length === 0,
            missingVars,
            resourcesFound: selectedResources.filter((resource) => resources.includes(resource)),
            unknownResources,
          };
        } catch {
          return {
            name: integrationName,
            valid: false,
            missingVars: [],
            resourcesFound: [],
            unknownResources: config.resources[integrationName] ?? [],
          };
        }
      })
    );

    const errors: string[] = [];
    const warnings: string[] = [];

    if (!destinationValid) {
      errors.push(`Destination type "${config.destination.type}" is not supported.`);
    }
    if (!schedule.valid) {
      errors.push(schedule.error ?? 'Invalid schedule.');
    }
    for (const integration of integrations) {
      if (integration.unknownResources.length > 0) {
        errors.push(
          `${integration.name}: unknown resources ${integration.unknownResources.join(', ')}`
        );
      }
      if (integration.missingVars.length > 0) {
        warnings.push(
          `${integration.name}: missing env vars ${integration.missingVars.join(', ')}`
        );
      }
    }

    const result: PipelineValidationResult = {
      valid: errors.length === 0,
      destinationValid,
      destinationType: config.destination.type,
      scheduleValid: schedule.valid,
      scheduleMessage: schedule.valid
        ? `${schedule.human} (${schedule.cron})`
        : (schedule.error ?? 'Invalid schedule'),
      integrations,
      errors,
      warnings,
    };

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
