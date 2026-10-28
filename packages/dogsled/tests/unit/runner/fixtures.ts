import type { ResolvedPipeline, ResolvedResource } from '../../../src/runner/config/loader.js';

export function makePipeline(overrides: Partial<ResolvedPipeline> = {}): ResolvedPipeline {
  return {
    name: 'test',
    source: 'test',
    schedule: 'hourly',
    cron: '0 * * * *',
    trigger: 'schedule',
    destinationNames: ['warehouse'],
    resources: [],
    tablePrefix: 'test__',
    enabled: true,
    runner: 'managed',
    ...overrides,
  };
}

export function makeResource(name: string): ResolvedResource {
  return { name };
}
