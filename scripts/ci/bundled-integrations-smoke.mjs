import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { BOBSLED_CORE_PACKAGE_NAME } from '../release/package-set.mjs';
import { repoRoot } from './shared.mjs';

// esbuild already ships with tsup (pinned by the workspace override), so the
// smoke reuses it instead of adding another root dependency.
function loadEsbuild() {
  const fromIntegrations = createRequire(path.join(repoRoot, 'packages/integrations/package.json'));
  return createRequire(fromIntegrations.resolve('tsup'))('esbuild');
}

function yamlFilesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return yamlFilesUnder(entryPath);
    return entry.isFile() && entry.name.endsWith('.yml') ? [entryPath] : [];
  });
}

function specName(filePath) {
  return parseYaml(readFileSync(filePath, 'utf8')).name;
}

/** What the packed `sources/` folder says the bundle must resolve, read before it is deleted. */
function expectedCatalog(sourcesDir) {
  const sources = readdirSync(sourcesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
  const actionsDir = (name) => path.join(sourcesDir, name, 'actions');
  return {
    sources,
    resources: Object.fromEntries(
      sources.map((name) => [
        name,
        yamlFilesUnder(path.join(sourcesDir, name, 'resources'))
          .map(specName)
          .sort(),
      ])
    ),
    meta: Object.fromEntries(
      sources.map((name) => [
        name,
        parseYaml(readFileSync(path.join(sourcesDir, name, 'meta.yml'), 'utf8')),
      ])
    ),
    actions: sources
      .flatMap((name) =>
        existsSync(actionsDir(name))
          ? readdirSync(actionsDir(name), { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
              .map((entry) => `${name}/${specName(path.join(actionsDir(name), entry.name))}`)
          : []
      )
      .sort(),
  };
}

const SMOKE_SCRIPT = `
import { readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const [bundleUrl, expectedPath, tempDir] = process.argv.slice(1);
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const { integrations, actions } = await import(bundleUrl);
const same = (label, actual, wanted) => {
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new Error(label + ' differs: ' + JSON.stringify(actual) + ' vs ' + JSON.stringify(wanted));
  }
};

same('bobsled_api source name', integrations.getSource('bobsled_api').name, 'bobsled_api');
same('source names', integrations.listSources().map((source) => source.name), expected.sources);
let resourceCount = 0;
for (const name of expected.sources) {
  const source = integrations.getSource(name);
  same(name + ' resource names', [...source.resource_names].sort(), expected.resources[name]);
  same(
    name + ' resources',
    integrations.getResources(name).map((entry) => entry.resource.name).sort(),
    expected.resources[name]
  );
  for (const [key, value] of Object.entries(expected.meta[name])) {
    same(name + ' meta.' + key, source.meta[key], value);
  }
  resourceCount += expected.resources[name].length;
}
const queryable = integrations.listQueryResources();
if (queryable.length === 0) throw new Error('No queryable resources resolved');
for (const summary of queryable) {
  integrations.loadQueryableResourceSpecs(summary.integration, summary.resource, {
    includeBillable: true,
  });
}
const builtInActions = actions.listActions();
same('actions', builtInActions.map((action) => action.qualifiedName).sort(), expected.actions);
for (const action of builtInActions) actions.getAction(action.integration, action.name);
same('temporary files written by lookups', readdirSync(tempDir), []);
process.stdout.write(
  'Bundled integrations: ' + expected.sources.length + ' sources, ' + resourceCount +
    ' resources, ' + queryable.length + ' queryable, ' + builtInActions.length +
    ' actions, no temporary files\\n'
);
`;

/**
 * Bundle the installed Dogsled package the way an app bundler (Nitro on Vercel)
 * does: inline every module into one file in a nested `_libs/` folder unlike the
 * package layout, delete the packed integrations `sources/` folder, then check
 * that the bundle resolves exactly the sources, resources, metadata and actions
 * that folder contained, and that lookups write nothing to the temp directory.
 */
export async function runBundledIntegrationsSmoke(installDir) {
  const packageDir = path.join(installDir, 'node_modules', ...BOBSLED_CORE_PACKAGE_NAME.split('/'));
  const sourcesDir = path.join(
    packageDir,
    'node_modules',
    '@bobsled-inc',
    'integrations',
    'sources'
  );
  if (!existsSync(sourcesDir)) {
    throw new Error(`Expected packed integration sources at ${sourcesDir}`);
  }
  const expectedPath = path.join(installDir, 'bundled-integrations-expected.json');
  writeFileSync(expectedPath, JSON.stringify(expectedCatalog(sourcesDir)));

  const functionDir = path.join(installDir, 'bundled-function');
  const entryPath = path.join(installDir, 'bundled-integrations-entry.mjs');
  const bundlePath = path.join(
    functionDir,
    '_libs',
    `${BOBSLED_CORE_PACKAGE_NAME.replace('/', '+')}+integrations.mjs`
  );
  mkdirSync(path.dirname(bundlePath), { recursive: true });
  writeFileSync(
    entryPath,
    [
      `export * as integrations from '${BOBSLED_CORE_PACKAGE_NAME}/integrations';`,
      `export * as actions from '${BOBSLED_CORE_PACKAGE_NAME}/actions';`,
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

  rmSync(sourcesDir, { recursive: true, force: true });
  for (const candidate of [
    path.join(functionDir, 'sources'),
    path.join(functionDir, '_libs', 'sources'),
  ]) {
    if (existsSync(candidate)) throw new Error(`Unexpected copied sources at ${candidate}`);
  }

  const tempDir = mkdtempSync(path.join(installDir, 'bundled-tmp-'));
  try {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        SMOKE_SCRIPT,
        pathToFileURL(bundlePath).href,
        expectedPath,
        tempDir,
      ],
      { cwd: functionDir, stdio: 'inherit', env: { ...process.env, TMPDIR: tempDir } }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
