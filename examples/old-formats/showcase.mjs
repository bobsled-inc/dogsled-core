import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { publicApi } from '../../scripts/e2e/harness.mjs';
export const id = 'S25';
export const limitations = [
  'Known limitation: old root config discovery must offer an explicit migration diagnostic.',
];
export async function run(ctx) {
  await ctx.write('integrations/plan_warehouse.yml', {
    spec_version: '1',
    type: 'integration',
    name: 'plan_warehouse',
    source_type: 'bigquery',
    auth_env_vars: ['SHOWCASE_PLAN_PROJECT'],
    connection: { project_id: '${{ env.SHOWCASE_PLAN_PROJECT }}', dataset: 'example_dataset' },
    auth: { type: 'adc' },
  });
  const protocol =
    JSON.stringify({
      _v: 1,
      type: 'SCHEMA',
      stream: 'orders',
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: ['id'],
      load_strategy: 'append',
    }) + '\n';
  const planArgs = [
    'load',
    'run',
    '--load-integration',
    'plan_warehouse',
    '--table-prefix',
    'oss_e2e_plan_',
    '--load-strategy',
    'full_refresh',
    '--dry-run',
  ];
  const unresolvedPlan = await ctx.cli(planArgs, { input: protocol, expected: null });
  assert.notEqual(unresolvedPlan.code, 0);
  assert.match(unresolvedPlan.stdout + unresolvedPlan.stderr, /SHOWCASE_PLAN_PROJECT/);
  ctx.env.SHOWCASE_PLAN_PROJECT = 'example-project';
  const plan = await ctx.cli(planArgs, { input: protocol });
  assert.match(plan.stderr, /^oss_e2e_plan_orders\s+full_refresh/m);
  await ctx.write('load-plan.yml', {
    integration: 'plan_warehouse',
    defaults: { load_strategy: 'merge' },
  });
  const filePlan = await ctx.cli(
    ['load', 'run', '--load-file', 'load-plan.yml', '--table-prefix', 'oss_e2e_file_', '--dry-run'],
    { input: protocol }
  );
  assert.match(filePlan.stderr, /^oss_e2e_file_orders\s+merge/m);
  await rm(path.join(ctx.project, 'load-plan.yml'));
  await rm(path.join(ctx.project, 'integrations/plan_warehouse.yml'));
  const { scanProject } = await publicApi('project-index');
  const {
    validateProjectPipelines,
    safeParsePipelineManifest,
    DogsledConfigSchema,
    buildPipelineManifestObject,
  } = await publicApi('manifest');
  const transports = [
    { id: 'default', type: 'http', base_url: 'https://api.example.com', auth: { type: 'none' } },
  ];
  // Blueprints written by Dash or by hand use either spelling; both are read with no warning.
  const spellings = ['dogsled', 'bobsled']; // rename:keep
  for (const spelling of spellings) {
    await ctx.write('integrations/demo.yml', {
      spec_version: '2',
      type: 'integration',
      name: 'bobsled_api',
      [`${spelling}_connection_ref`]: 'api-binding',
      [`${spelling}_source_kind`]: 'bobsled_api',
      transports,
    });
    await ctx.write('dogsled.yml', {
      destinations: {
        warehouse: {
          type: `${spelling}_managed`,
          [`${spelling}_connection_ref`]: 'warehouse-demo',
        },
      },
      pipelines: {
        demo: {
          source: 'bobsled_api',
          destination: 'warehouse',
          resources: ['shares'],
          schedule: 'manual',
          runner: 'managed',
        },
      },
    });
    const index = scanProject(ctx.project);
    assert.equal(index.issues.length, 0);
    assert.equal((index.deprecations ?? []).length, 0);
    const validation = await validateProjectPipelines({ projectRoot: ctx.project, index });
    assert.equal(validation.status, 'valid');
    assert.equal(
      validation.warnings.filter((warning) => /LEGACY_BLUEPRINT_KEY/.test(warning)).length,
      0
    );
    const accepted = await ctx.cli(['doctor', '--json']);
    assert.doesNotMatch(accepted.stdout + accepted.stderr, /LEGACY_BLUEPRINT_KEY/);
  }
  const [refA, refB] = ['dogsled_connection_ref', 'bobsled_connection_ref']; // rename:keep
  const [kindA, kindB] = ['dogsled_source_kind', 'bobsled_source_kind']; // rename:keep
  await ctx.write('integrations/demo.yml', {
    spec_version: '2',
    type: 'integration',
    name: 'bobsled_api',
    [refB]: 'old',
    [refA]: 'new',
    transports,
  });
  const conflict = await ctx.cli(['doctor', '--json'], { expected: null });
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stdout + conflict.stderr, /LEGACY_KEY_CONFLICT/);
  await ctx.write('integrations/demo.yml', {
    spec_version: '2',
    type: 'integration',
    name: 'bobsled_api',
    [kindB]: 'bobsled_api',
    [kindA]: 'other',
    transports,
  });
  const kindConflict = await ctx.cli(['doctor', '--json'], { expected: null });
  assert.notEqual(kindConflict.code, 0);
  assert.match(kindConflict.stdout + kindConflict.stderr, /LEGACY_KEY_CONFLICT/);
  await ctx.write('integrations/demo.yml', {
    spec_version: '2',
    type: 'integration',
    name: 'bobsled_api',
    [refB]: 'same',
    [refA]: 'same',
    [kindB]: 'bobsled_api',
    [kindA]: 'bobsled_api',
    transports,
  });
  assert.equal(scanProject(ctx.project).issues.length, 0);
  await ctx.write('dogsled.yml', {
    destinations: {
      warehouse: { type: 'dogsled_managed', [refB]: 'old', [refA]: 'new' },
    },
    pipelines: {},
  });
  const destinationConflict = await ctx.cli(['doctor', '--json'], { expected: null });
  assert.notEqual(destinationConflict.code, 0);
  assert.match(destinationConflict.stdout + destinationConflict.stderr, /LEGACY_KEY_CONFLICT/);
  const rejected = DogsledConfigSchema.safeParse({
    destinations: {
      warehouse: { type: 'bobsled_lakehouse', dogsled_connection_ref: 'warehouse-demo' },
    },
    pipelines: {},
  });
  assert.equal(rejected.success, false);
  assert.match(rejected.error.message, /use dogsled_managed/);
  await ctx.write('dogsled.yml', {
    destinations: {
      warehouse: { type: 'bobsled_lakehouse', dogsled_connection_ref: 'warehouse-demo' },
    },
    pipelines: {},
  });
  const retired = await ctx.cli(['doctor', '--json'], { expected: null });
  assert.notEqual(retired.code, 0);
  assert.match(retired.stdout + retired.stderr, /use dogsled_managed/);

  const currentManifest = buildPipelineManifestObject(
    [
      {
        cron: '0 * * * *',
        graphId: 'showcase_orders',
        integration: 'shop_api',
        modelSequence: [],
        pipelineName: 'orders',
        resources: ['orders'],
        runModels: false,
        schedule: 'hourly',
        trigger: 'schedule',
      },
    ],
    [],
    'showcase'
  );
  assert.equal(safeParsePipelineManifest(currentManifest).success, true);
  const manifest = safeParsePipelineManifest({ ...currentManifest, version: 6 });
  assert.equal(manifest.success, false);
  assert.equal(manifest.issues[0]?.code, 'unsupported_version');
  assert.equal(
    safeParsePipelineManifest({ ...currentManifest, kind: 'track.pipeline.dag' }).success,
    false
  );
  await rm(path.join(ctx.project, 'integrations'), { recursive: true });
  await ctx.write('dogsled.yml', 'pipelines: [\n');
  const broken = await ctx.cli(['doctor', '--json'], { expected: null });
  assert.notEqual(broken.code, 0);
  assert.match(broken.stdout + broken.stderr, /line\s+\d+/i);
  assert.doesNotMatch(broken.stdout + broken.stderr, /^\s+at .+:\d+:\d+\)?$/m);
  await rm(path.join(ctx.project, 'dogsled.yml'));
  await ctx.write('track.yml', 'pipelines: {}\n');
  const old = await ctx.cli(['doctor', '--json'], { expected: null });
  assert.equal(old.code, 1, 'Known limitation: retired root config has no migration diagnostic');
  assert.match(old.stdout + old.stderr, /Could not find a Dogsled Project/);
  assert.doesNotMatch(old.stdout + old.stderr, /^\s+at .+:\d+:\d+\)?$/m);
}
