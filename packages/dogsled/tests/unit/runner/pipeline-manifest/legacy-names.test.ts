import { describe, expect, it } from 'vitest';

import {
  buildPipelineManifestObject,
  safeParsePipelineManifest,
} from '../../../../src/manifest.js';

// Compatibility test: the rename never rewrites this file. A manifest written by Dogsled Core and
// one written by Bobsled Core must both parse, to the same result.
const DOGSLED = [
  ['dogsled.pipeline.dag', 'bobsled.pipeline.dag'],
  ['dogsled.runner.run_resource', 'bobsled.runner.run_resource'],
  ['dogsled.model.run', 'bobsled.model.run'],
  ['"dogsled_cli_version"', '"bobsled_cli_version"'],
  ['"default_command":"dogsled"', '"default_command":"bobsled"'],
  ['"DOGSLED_PIPELINE_COMMAND"', '"BOBSLED_CORE_PIPELINE_COMMAND"'],
  ['"DOGSLED_PIPELINE_CWD"', '"BOBSLED_CORE_PIPELINE_CWD"'],
  ['"DOGSLED_PIPELINE_TIMEOUT_SECONDS"', '"BOBSLED_CORE_PIPELINE_TIMEOUT_SECONDS"'],
] as const;

/** The same manifest in the Dogsled and in the Bobsled spelling, whichever Core wrote it. */
function spellings(manifest: unknown): { dogsled: unknown; bobsled: unknown } {
  let dogsled = JSON.stringify(manifest);
  for (const [old, current] of DOGSLED) dogsled = dogsled.replaceAll(current, old);
  let bobsled = dogsled;
  for (const [old, current] of DOGSLED) bobsled = bobsled.replaceAll(old, current);
  return { dogsled: JSON.parse(dogsled), bobsled: JSON.parse(bobsled) };
}

const manifest = buildPipelineManifestObject(
  [
    {
      cron: '0 * * * *',
      graphId: 'orders_graph',
      integration: 'stripe',
      modelSequence: ['daily_revenue'],
      modelNodes: [{ name: 'daily_revenue', refs: [] }],
      modelIntegration: 'warehouse',
      pipelineName: 'orders',
      resources: ['charges'],
      runModels: true,
      schedule: 'hourly',
      trigger: 'schedule',
    } as never,
  ],
  [],
  'test-version'
);

describe('pipeline manifests from either Core generation', () => {
  it('parses the Dogsled and the Bobsled spelling to the same manifest', () => {
    const { dogsled, bobsled } = spellings(manifest);
    expect(JSON.stringify(dogsled)).toContain('dogsled.pipeline.dag');
    expect(JSON.stringify(bobsled)).toContain('bobsled.pipeline.dag');
    const fromDogsled = safeParsePipelineManifest(dogsled);
    const fromBobsled = safeParsePipelineManifest(bobsled);
    expect(fromDogsled).toMatchObject({ success: true });
    expect(fromBobsled).toEqual(fromDogsled);
    expect(safeParsePipelineManifest(manifest)).toEqual(fromDogsled);
  });

  it('keeps Track-era manifests rejected', () => {
    const track = JSON.parse(
      JSON.stringify(spellings(manifest).dogsled).replaceAll('dogsled.', 'track.')
    );
    expect(safeParsePipelineManifest(track)).toMatchObject({ success: false });
  });

  it('rejects both CLI version fields with different values', () => {
    const { dogsled } = spellings(manifest) as { dogsled: Record<string, unknown> };
    expect(safeParsePipelineManifest({ ...dogsled, bobsled_cli_version: 'other' })).toMatchObject({
      success: false,
    });
  });
});
