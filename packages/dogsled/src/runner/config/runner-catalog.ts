import type { PipelineRunner } from './schema.js';

export interface RunnerCapabilities {
  readonly name: PipelineRunner;
  readonly display_name: string;
  readonly description: string;
  readonly is_default: boolean;
  readonly supports_for_each_iteration: boolean;
}

export const RUNNER_CATALOG: Readonly<Record<PipelineRunner, RunnerCapabilities>> = Object.freeze({
  managed: Object.freeze({
    name: 'managed',
    display_name: 'Managed',
    description:
      'Compiles enabled extract pipelines into a portable task DAG. Resource groups run as subprocess nodes, with for_each parents and children co-located.',
    is_default: true,
    supports_for_each_iteration: true,
  }),
});

export function getRunnerCapabilities(runner: PipelineRunner): RunnerCapabilities {
  return { ...RUNNER_CATALOG[runner] };
}

export function listRunnerCapabilities(): RunnerCapabilities[] {
  return Object.values(RUNNER_CATALOG).map((caps) => ({ ...caps }));
}
