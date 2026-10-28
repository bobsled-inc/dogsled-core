import type { SetupDestination, SetupSource } from './types.js';

export const AGENT_GUIDE_PLACEHOLDER_SENTENCE =
  'Replace this paragraph; agents read it before they interpret a question.';

export function formatDestination(destination: SetupDestination): string {
  switch (destination.type) {
    case 'bigquery':
      return `bigquery (${destination.project}.${destination.dataset})`;
    case 'duckdb':
      return `duckdb (${destination.db_path})`;
    case 'snowflake':
      return `snowflake (${destination.account}/${destination.database})`;
    case 'postgres':
      return `postgres (${destination.host}/${destination.database})`;
    case 'clickhouse':
      return `clickhouse (${destination.host}/${destination.database})`;
    case 'turbopuffer':
      return `turbopuffer (${destination.region ?? 'gcp-us-central1'})`;
    case 'local':
      return `local (${destination.format})`;
    case 's3':
      return `s3 (${destination.bucket}/${destination.prefix ?? ''})`;
    case 'gcs':
      return `gcs (${destination.bucket}/${destination.prefix ?? ''})`;
  }
}

export function buildAgentGuide(
  repoName: string,
  sources: SetupSource[],
  destination: SetupDestination
): string {
  const integrations = sources.map((source) => `\`${source.integration}\``).join(', ');
  return `# ${repoName} — Agent Guide

## Repo Purpose

This repo is a Dogsled Project. Project files are the source of truth. Pipeline configuration is optional. An optional root \`dogsled.yml\` can hold all pipeline configuration, or typed \`pipeline_config\` fragments can split it across the Project.

Declare \`type\` to place a YAML file anywhere. If a file is untyped, Dogsled uses the nearest exact conventional folder to infer only its kind, not its name or namespace. Nested domain folders work the same way; for example, an untyped file under \`golf/datagolf/pga/metrics/\` is inferred as a metric.

Local Project commands use the current directory as the Project root. From a nested directory, pass \`--project-root /path/to/project\`. If you also pass \`--config\`, its path is relative to the Project root and selects one file. Prefer \`dogsled setup\` and \`dogsled runner\` commands over manual workflow edits.

## About this data

Describe the business and what the data in this project represents. ${AGENT_GUIDE_PLACEHOLDER_SENTENCE}

## Queryable data

- Loaded tables come from ${integrations || 'the configured integrations'} and land in the destination below.
- List each MODEL_SPEC model, which questions it answers, and whether it is materialized or read live.

## Vocabulary

- Define each business term once and name the model or column that carries it.

## Conventions

- State currency, time zone, fiscal calendar, identifier rules, and default filters.

## Caveats

- Record known gaps, drift, backfills, and data to avoid.

## Pipelines

${sources.map((source) => `- \`${source.integration}\` — schedule: \`${source.schedule}\``).join('\n')}

## Destination

- ${formatDestination(destination)}

## Project Skills

Project-owned agent guidance lives under \`skills/\`. Edit that directory only. Run \`dogsled skill validate\` after changes and \`dogsled skill sync\` to refresh agent discovery adapters.

## Core Commands

- \`dogsled setup doctor\`
- \`dogsled runner validate\`
- \`dogsled runner run <pipeline>\``;
}
