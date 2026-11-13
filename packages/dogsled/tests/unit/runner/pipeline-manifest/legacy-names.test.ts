import { describe, expect, it } from 'vitest';

import {
  buildPipelineManifestObject,
  safeParsePipelineManifest,
} from '../../../../src/manifest.js';

// Compatibility test: the rename never rewrites this file. A manifest written by Dogsled Core, one
// written by Bobsled Core and one with Track names must all parse, to the same result.
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

  it('parses Track names for the kinds and the CLI version field to the same manifest', () => {
    const { dogsled } = spellings(manifest);
    const track = JSON.parse(
      JSON.stringify(dogsled)
        .replaceAll('"dogsled.', '"track.')
        .replaceAll('"dogsled_cli_version"', '"track_cli_version"')
    );
    expect(JSON.stringify(track)).toContain('track.model.run');
    expect(safeParsePipelineManifest(track)).toEqual(safeParsePipelineManifest(dogsled));
  });

  it('keeps manifests of version 6 rejected whatever their spelling', () => {
    const { dogsled } = spellings(manifest) as { dogsled: Record<string, unknown> };
    expect(safeParsePipelineManifest({ ...dogsled, version: 6 })).toMatchObject({
      success: false,
    });
  });

  it('accepts CLI version fields in two spellings when they hold the same value', () => {
    const { dogsled, bobsled } = spellings(manifest) as Record<string, Record<string, unknown>>;
    const both = { ...dogsled, bobsled_cli_version: dogsled['dogsled_cli_version'] };
    expect(safeParsePipelineManifest(both)).toEqual(safeParsePipelineManifest(bobsled));
  });

  it('rejects both CLI version fields with different values', () => {
    const { dogsled } = spellings(manifest) as { dogsled: Record<string, unknown> };
    expect(safeParsePipelineManifest({ ...dogsled, bobsled_cli_version: 'other' })).toMatchObject({
      success: false,
    });
  });
});
