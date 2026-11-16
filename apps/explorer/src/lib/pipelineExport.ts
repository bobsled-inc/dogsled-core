import { stringify } from 'yaml';
import type { ExplorerCommand, ExplorerBobsledCommand } from './command-links.js';

export interface PipelineConfig {
  selectedIntegrations: string[];
  resources: Record<string, string[]>;
  destination: {
    type: string;
    db_path?: string;
    project?: string;
    dataset?: string;
    bucket?: string;
    prefix?: string;
  };
  schedule: string;
}

export interface PipelineEntry {
  type: 'extract';
  source: string;
  destination: string;
  schedule: string;
  resources: string[];
}

export interface PipelineCliOptions {
  destination: PipelineConfig['destination'];
  integration: string;
  resources?: string[];
}

export function buildPipelineRunCommands(config: PipelineConfig): ExplorerBobsledCommand[] {
  return config.selectedIntegrations.map((integration) => ({
    command: 'pipeline',
    args: buildPipelineCliArgs({
      integration,
      resources: config.resources[integration] ?? [],
      destination: config.destination,
    }),
  }));
}

export function isPipelineConfig(value: unknown): value is PipelineConfig {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record['selectedIntegrations']) &&
    typeof record['resources'] === 'object' &&
    record['resources'] !== null &&
    typeof record['destination'] === 'object' &&
    record['destination'] !== null &&
    typeof (record['destination'] as Record<string, unknown>)['type'] === 'string' &&
    typeof record['schedule'] === 'string'
  );
}

export function generateBobsledYml(config: PipelineConfig): string {
  const pipelines: Record<string, PipelineEntry> = {};
  for (const integration of config.selectedIntegrations) {
    pipelines[integration] = {
      type: 'extract',
      source: integration,
      destination: 'default',
      schedule: config.schedule,
      resources: config.resources[integration] ?? [],
    };
  }
  const destination = { ...config.destination };
  const yml = { destinations: { default: destination }, pipelines };
  return stringify(yml, { lineWidth: 120 });
}

export function buildPipelineCliArgs(options: PipelineCliOptions): string[] {
  const args: string[] = ['--integration', options.integration, '--dest', options.destination.type];

  if (options.destination.type === 'duckdb') {
    args.push('--db-path', options.destination.db_path ?? './pipeline.duckdb');
  } else if (options.destination.type === 'bigquery') {
    args.push(
      '--project-id',
      options.destination.project ?? 'my-project',
      '--dataset-id',
      options.destination.dataset ?? 'raw_data'
    );
  } else if (options.destination.type === 'local') {
    args.push('--output-dir', options.destination.prefix ?? './output');
  } else if (options.destination.type === 's3') {
    if (options.destination.bucket) {
      args.push('--s3-bucket', options.destination.bucket);
    }
    if (options.destination.prefix) {
      args.push('--s3-prefix', options.destination.prefix);
    }
  } else if (options.destination.type === 'gcs') {
    if (options.destination.bucket) {
      args.push('--gcs-bucket', options.destination.bucket);
    }
    if (options.destination.prefix) {
      args.push('--gcs-prefix', options.destination.prefix);
    }
  }

  if (options.resources && options.resources.length > 0) {
    args.push('--resource', ...options.resources);
  }

  return args;
}

export function buildPipelineRunArgs(config: PipelineConfig): ExplorerCommand {
  const commands = buildPipelineRunCommands(config);
  if (commands.length === 0) {
    return { command: 'pipeline', args: ['--help'] };
  }

  return commands.length === 1 ? commands[0]! : { sequence: commands };
}
