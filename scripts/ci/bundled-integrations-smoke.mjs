import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from './shared.mjs';

// esbuild already ships with tsup (pinned by the workspace override), so the
// smoke reuses it instead of adding another root dependency.
function loadEsbuild() {
  const fromIntegrations = createRequire(path.join(repoRoot, 'packages/integrations/package.json'));
  return createRequire(fromIntegrations.resolve('tsup'))('esbuild');
}

function findSourceTrees(root) {
  const found = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name === 'sources') found.push(entryPath);
      else visit(entryPath);
    }
  }
  visit(root);
  return found;
}

const SMOKE_SCRIPT = `
const bundlePath = process.argv[1];
const { integrations, actions } = await import(bundlePath);
const bobsled = integrations.getSource('bobsled_api');
if (bobsled.name !== 'bobsled_api') throw new Error('bobsled_api did not resolve');
const names = integrations.listSources().map((source) => source.name);
if (names.length < 50) throw new Error('Expected the built-in catalog, found ' + names.length + ' sources');
let resourceCount = 0;
for (const name of names) {
  const source = integrations.getSource(name);
  const resources = integrations.getResources(name);
  if (resources.length !== source.resource_names.length) throw new Error('Resources missing for ' + name);
  resourceCount += resources.length;
}
const queryable = integrations.listQueryResources();
if (queryable.length === 0) throw new Error('No queryable resources resolved');
for (const summary of queryable) {
  integrations.loadQueryableResourceSpecs(summary.integration, summary.resource, { includeBillable: true });
}
const builtInActions = actions.listActions();
if (builtInActions.length === 0) throw new Error('No built-in actions resolved');
for (const action of builtInActions) {
  actions.getAction(action.integration, action.name);
}
process.stdout.write(
  'Bundled integrations: ' + names.length + ' sources, ' + resourceCount + ' resources, ' +
  queryable.length + ' queryable, ' + builtInActions.length + ' actions\\n'
);
`;

/**
 * Bundle the installed Dogsled package the way an app bundler (Nitro on Vercel)
 * does: inline every module into one file in a nested `_libs/@bobsled-inc/`
 * folder unlike the package layout, delete every `sources/` folder in the install
 * (including any an app might have copied next to the bundle), then resolve
 * every built-in integration, query resource and action from the bundle.
 */
export async function runBundledIntegrationsSmoke(installDir) {
  const functionDir = path.join(installDir, 'bundled-function');
  const entryPath = path.join(installDir, 'bundled-integrations-entry.mjs');
  const bundlePath = path.join(functionDir, '_libs', '@bobsled-inc', 'dogsled+integrations.mjs');
  mkdirSync(path.dirname(bundlePath), { recursive: true });
  writeFileSync(
    entryPath,
    [
      "export * as integrations from '@bobsled-inc/dogsled/integrations';",
      "export * as actions from '@bobsled-inc/dogsled/actions';",
      '',
    ].join('\n')
  );

  await loadEsbuild().build({
    absWorkingDir: installDir,
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'error',
    external: ['@duckdb/*', 'better-sqlite3'],
    banner: {
      js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
    },
  });

  for (const directory of findSourceTrees(installDir)) {
    rmSync(directory, { recursive: true, force: true });
  }

  execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', SMOKE_SCRIPT, pathToFileURL(bundlePath).href],
    { cwd: functionDir, stdio: 'inherit' }
  );
}
