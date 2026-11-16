import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expectedScenarioIds, assertScenarioIds, assertScenarioResults } from './scenario-list.mjs';
import { command, context, isolatedEnv } from './harness.mjs';

test('CLI runs in a clean project without inherited credentials', async () => {
  const ctx = await context('harness');
  try {
    assert.equal(isolatedEnv(ctx.project).NPM_TOKEN, undefined);
    assert.equal(isolatedEnv(ctx.project).GOOGLE_APPLICATION_CREDENTIALS, undefined);
    const version = await ctx.cli(['--version']);
    assert.match(version.stdout, /\d+\.\d+\.\d+/);
    const help = await ctx.cli(['--help']);
    assert.match(help.stdout, /Bobsled Core/);
  } finally {
    await ctx.cleanup();
  }
});

async function discoveryFixture(source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bobsled-discovery-'));
  await mkdir(path.join(directory, 'scripts/e2e'), { recursive: true });
  await mkdir(path.join(directory, 'examples/example'), { recursive: true });
  await writeFile(
    path.join(directory, 'scripts/e2e/run.mjs'),
    await readFile(new URL('./run.mjs', import.meta.url))
  );
  await writeFile(
    path.join(directory, 'scripts/e2e/scenario-list.mjs'),
    await readFile(new URL('./scenario-list.mjs', import.meta.url))
  );
  await writeFile(
    path.join(directory, 'scripts/e2e/harness.mjs'),
    `export const root = ${JSON.stringify(directory)}; export async function context() { throw new Error('Unexpected scenario execution'); }`
  );
  await writeFile(
    path.join(directory, 'scripts/e2e/services.mjs'),
    'export async function stopServices() {}'
  );
  if (source !== undefined)
    await writeFile(path.join(directory, 'examples/example/showcase.mjs'), source);
  try {
    return await command(process.execPath, [path.join(directory, 'scripts/e2e/run.mjs')], {
      cwd: directory,
      env: isolatedEnv(directory),
      expected: null,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('full discovery rejects missing showcases while ignoring non-showcase directories', async () => {
  const result = await discoveryFixture();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /every expected showcase/);
});

test('discovery fails when an existing showcase has a missing dependency', async () => {
  const result = await discoveryFixture(
    "import './missing-provider.mjs'; export const id = 'S99';"
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing-provider\.mjs/);
});

test('full suite requires exact IDs and applicable result counts', () => {
  assert.doesNotThrow(() => assertScenarioIds(expectedScenarioIds));
  assert.throws(() => assertScenarioIds(expectedScenarioIds.slice(1)));
  assert.throws(() => assertScenarioIds([...expectedScenarioIds, 'S01']));
  assert.throws(() => assertScenarioIds([...expectedScenarioIds.slice(1), 'S99']));
  assert.doesNotThrow(() => assertScenarioResults(15, 0, false));
  assert.doesNotThrow(() => assertScenarioResults(14, 1, true));
  assert.throws(() => assertScenarioResults(14, 0, false));
  assert.throws(() => assertScenarioResults(13, 2, true));
});

test('showcase aggregation rejects missing, duplicate, failed, skipped, and misassigned results', async () => {
  const { aggregateResults, showcaseLegs } = await import('./run.mjs');
  assertScenarioIds(Object.values(showcaseLegs).flat());
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bobsled-results-'));
  const reports = Object.entries(showcaseLegs).map(([leg, ids]) => ({
    leg,
    results: ids.map((scenario) => ({ scenario, status: 'PASS' })),
  }));
  const save = async (values) => {
    for (const report of values)
      await writeFile(path.join(directory, `${report.leg}.json`), JSON.stringify(report));
  };
  try {
    await assert.rejects(aggregateResults(directory));
    await save(reports);
    await aggregateResults(directory);
    for (const mutate of [
      (report) => report.results.pop(),
      (report) => report.results.push(report.results[0]),
      (report) => {
        report.results[0].status = 'FAIL';
      },
      (report) => {
        report.results[0].status = 'NOT_APPLICABLE';
      },
      (report) => {
        report.results[0].scenario = 'S01';
      },
      (report) => {
        report.leg = 'wrong';
      },
    ]) {
      const broken = structuredClone(reports);
      mutate(broken[0]);
      await save(reports);
      await writeFile(path.join(directory, 'audit.json'), JSON.stringify(broken[0]));
      await assert.rejects(aggregateResults(directory));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
