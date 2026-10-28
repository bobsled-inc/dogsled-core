import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedScenarioIds, assertScenarioIds, assertScenarioResults } from './scenario-list.mjs';

export const showcaseLegs = {
  audit: ['S06', 'S07', 'S14', 'S17', 'S24'],
  core: expectedScenarioIds.filter((id) => !['S06', 'S07', 'S14', 'S17', 'S24'].includes(id)),
};

export async function aggregateResults(directory) {
  const results = [];
  for (const [leg, ids] of Object.entries(showcaseLegs)) {
    const report = JSON.parse(await readFile(path.join(directory, `${leg}.json`), 'utf8'));
    if (report.leg !== leg || !Array.isArray(report.results))
      throw new Error('Invalid showcase report');
    const actual = report.results.map((result) => result.scenario).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...ids].sort()))
      throw new Error(`Showcase leg ${leg} must report each assigned scenario exactly once`);
    results.push(...report.results);
  }
  assertScenarioIds(results.map((result) => result.scenario));
  assertScenarioResults(
    results.filter((result) => result.status === 'PASS').length,
    results.filter((result) => result.status !== 'PASS').length,
    false
  );
  process.stdout.write(`All ${results.length} showcases ran and passed across both legs.\n`);
}

async function main(argv) {
  if (argv[0] === '--aggregate') {
    if (argv.length !== 2) throw new Error('Pass --aggregate <results directory>');
    await aggregateResults(argv[1]);
    return;
  }
  const selected = [];
  let leg;
  let resultsPath;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--leg' && !leg) leg = argv[++index];
    else if (arg === '--results' && !resultsPath) resultsPath = argv[++index];
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else selected.push(arg);
  }
  if (leg && (!showcaseLegs[leg] || selected.length || !resultsPath))
    throw new Error('Pass a known --leg with --results and no individual scenarios');
  const { context, root } = await import('./harness.mjs');
  const { stopServices } = await import('./services.mjs');
  const results = [];
  const directories = await readdir(path.join(root, 'examples'), { withFileTypes: true });
  const scenarios = [];
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const module = path.join(root, 'examples', entry.name, 'showcase.mjs');
    try {
      await access(module);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const scenario = await import(pathToFileURL(module).href);
    if (
      leg ||
      !selected.length ||
      selected.includes(entry.name) ||
      selected.includes(scenario.id)
    ) {
      scenarios.push({ ...scenario, name: entry.name });
    }
  }
  scenarios.sort((a, b) => a.id.localeCompare(b.id));
  if (
    selected.some(
      (name) => !scenarios.some((scenario) => [scenario.id, scenario.name].includes(name))
    )
  ) {
    throw new Error(`Unknown showcase: ${selected.join(', ')}`);
  }
  if (!selected.length) assertScenarioIds(scenarios.map((scenario) => scenario.id));
  if (leg) {
    const assigned = showcaseLegs[leg];
    scenarios.splice(
      0,
      scenarios.length,
      ...scenarios.filter((scenario) => assigned.includes(scenario.id))
    );
  }
  let passed = 0;
  let skipped = 0;
  try {
    for (const scenario of scenarios) {
      if (scenario.id === 'S17' && process.env.DOGSLED_E2E_OUTSIDER === '1') {
        process.stdout.write(
          JSON.stringify({
            scenario: 'S17',
            status: 'NOT_APPLICABLE',
            reason:
              'Known limitation: Explorer is not distributed in the npm package; source CI covers it.',
          }) + '\n'
        );
        results.push({ scenario: scenario.id, status: 'NOT_APPLICABLE' });
        skipped++;
        continue;
      }
      const ctx = await context(scenario.name);
      const start = performance.now();
      try {
        await scenario.run(ctx);
        process.stdout.write(
          `${JSON.stringify({
            scenario: scenario.id,
            name: scenario.name,
            status: 'PASS',
            limitations: scenario.limitations ?? [],
            seconds: +((performance.now() - start) / 1000).toFixed(2),
          })}\n`
        );
        results.push({ scenario: scenario.id, status: 'PASS' });
        passed++;
        await ctx.cleanup();
      } catch (error) {
        process.stderr.write(
          `${scenario.id} failed; temporary project retained at ${ctx.project}\n`
        );
        throw error;
      }
    }
  } finally {
    await stopServices();
  }
  if (!selected.length && !leg)
    assertScenarioResults(passed, skipped, process.env.DOGSLED_E2E_OUTSIDER === '1');
  process.stdout.write(`Showcases passed: ${passed}; not applicable: ${skipped}\n`);

  if (resultsPath) {
    await mkdir(path.dirname(resultsPath), { recursive: true });
    await writeFile(resultsPath, `${JSON.stringify({ leg, results })}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
