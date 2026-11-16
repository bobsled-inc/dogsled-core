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
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { INLINED_AI_DEPENDENCY_NAMES } from '../release/package-set.mjs';
import { runBundledIntegrationsSmoke } from './bundled-integrations-smoke.mjs';
import { stageBobsledPackage } from '../release/stage-package.mjs';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'bobsled-packed-catalog-'));
const stageDir = path.join(temporaryRoot, 'stage');
const packDir = path.join(temporaryRoot, 'pack');
const installDir = path.join(temporaryRoot, 'install');
const peerGraphDir = path.join(temporaryRoot, 'peer-graph');
const skipBuild = process.argv.includes('--skip-build');

function removeInstalledDirectories(root, predicate) {
  let removed = 0;

  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(directory, entry.name);
      if (predicate(entryPath)) {
        rmSync(entryPath, { recursive: true, force: true });
        removed += 1;
      } else {
        visit(entryPath);
      }
    }
  }

  visit(root);
  return removed;
}

try {
  mkdirSync(packDir);
  mkdirSync(installDir);
  mkdirSync(peerGraphDir);
  stageBobsledPackage(stageDir, { build: !skipBuild });

  const packOutput = execFileSync('npm', ['pack', '--pack-destination', packDir], {
    cwd: stageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const tarballs = readdirSync(packDir).filter((entry) => entry.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error('Expected one packed Dogsled tarball; npm pack output was ' + packOutput);
  }

  writeFileSync(
    path.join(installDir, 'package.json'),
    JSON.stringify(
      {
        name: 'bobsled-packed-catalog-smoke',
        private: true,
        type: 'module',
      },
      null,
      2
    ) + '\n'
  );
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(packDir, tarballs[0])],
    { cwd: installDir, stdio: 'inherit' }
  );

  const catalogSmokeScript = [
    'process.dlopen = () => {',
    "  throw new Error('native dependency loaded during packed catalog import');",
    '};',
    "await import('@aws-sdk/client-s3');",
    "const catalog = await import('@bobsled-inc/bobsled-core/integrations/catalog');",
    "if (typeof catalog.probeApiResource !== 'function') {",
    "  throw new Error('probeApiResource export missing from packed Dogsled package');",
    '}',
    "if (typeof catalog.buildCatalogManifest !== 'function') {",
    "  throw new Error('buildCatalogManifest export missing from packed Dogsled package');",
    '}',
  ].join('\n');
  execFileSync(process.execPath, ['--input-type=module', '--eval', catalogSmokeScript], {
    cwd: installDir,
    stdio: 'inherit',
  });

  const bundledAiUrl = pathToFileURL(
    path.join(
      installDir,
      'node_modules',
      '@bobsled-inc',
      'bobsled-core',
      'node_modules',
      '@bobsled-inc',
      'ai',
      'dist',
      'index.js'
    )
  ).href;
  const ollamaSmokeScript = [
    `const { resolveProviderModels } = await import(${JSON.stringify(bundledAiUrl)});`,
    "const models = await resolveProviderModels({ provider: 'ollama', model: 'llama3', base_url: 'http://127.0.0.1:11434/api' });",
    "if (!models.languageModel) throw new Error('bundled Ollama provider did not resolve');",
  ].join('\n');
  execFileSync(process.execPath, ['--input-type=module', '--eval', ollamaSmokeScript], {
    cwd: installDir,
    stdio: 'inherit',
  });

  // Built-in integrations must resolve once an app bundler moves the code and
  // no sources/ folder exists anywhere (the `Source "bobsled_api" not found` incident).
  // The smoke asserts the packed integration sources exist, then deletes them.
  await runBundledIntegrationsSmoke(installDir);

  const installedNodeModules = path.join(installDir, 'node_modules');
  removeInstalledDirectories(installedNodeModules, (candidate) => {
    return (
      path.basename(candidate) === 'sources' &&
      path.basename(path.dirname(candidate)) === 'integrations' &&
      path.basename(path.dirname(path.dirname(candidate))) === '@bobsled-inc'
    );
  });

  const blockedPackageNames = new Set([
    'connections',
    'embedder',
    'extractor',
    'integrations',
    'loader',
  ]);
  removeInstalledDirectories(installedNodeModules, (candidate) => {
    const parent = path.basename(path.dirname(candidate));
    return (
      (parent === '@bobsled-inc' && blockedPackageNames.has(path.basename(candidate))) ||
      (parent === 'node_modules' && path.basename(candidate) === '@duckdb')
    );
  });

  const loaderPath = path.join(installDir, 'block-validation-dependencies.mjs');
  writeFileSync(
    loaderPath,
    [
      'const forbidden = [',
      "  '@bobsled-inc/connections',",
      "  '@bobsled-inc/embedder',",
      "  '@bobsled-inc/extractor',",
      "  '@bobsled-inc/integrations',",
      "  '@bobsled-inc/loader',",
      '];',
      'export async function resolve(specifier, context, nextResolve) {',
      "  if (forbidden.some((name) => specifier === name || specifier.startsWith(name + '/')) || specifier.startsWith('@duckdb/')) {",
      "    throw new Error('FORBIDDEN_VALIDATION_DEPENDENCY:' + specifier);",
      '  }',
      '  return nextResolve(specifier, context);',
      '}',
      '',
    ].join('\n')
  );

  const loaderRegistrationPath = path.join(installDir, 'register-validation-loader.mjs');
  writeFileSync(
    loaderRegistrationPath,
    [
      "import { register } from 'node:module';",
      "register('./block-validation-dependencies.mjs', import.meta.url);",
      '',
    ].join('\n')
  );

  const validationSmokePath = path.join(installDir, 'validate-managed-projects.mjs');
  writeFileSync(
    validationSmokePath,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

process.dlopen = () => {
  throw new Error('native dependency loaded during packed project validation');
};

const {
  generateProjectManifest,
  resolveProjectPipelines,
  BobsledProjectValidationError,
} = await import('@bobsled-inc/bobsled-core/manifest');
const { BUILT_IN_VALIDATION_CATALOG } = await import('@bobsled-inc/bobsled-core/validation');

if (!BUILT_IN_VALIDATION_CATALOG.getIntegration('posthog').resource_names.includes('events')) {
  throw new Error('PostHog validation metadata missing from public Dogsled surface');
}
if (!BUILT_IN_VALIDATION_CATALOG.getIntegration('notion').resource_names.includes('pages_rest')) {
  throw new Error('Notion validation metadata missing from public Dogsled surface');
}

function writeProject(name, source, resources, via) {
  const projectRoot = path.join(process.cwd(), name);
  mkdirSync(projectRoot);
  writeFileSync(
    path.join(projectRoot, 'bobsled.yml'),
    [
      'destinations:',
      '  managed:',
      '    type: bobsled_managed',
      '    bobsled_connection_ref: bobsled-managed',
      'pipelines:',
      '  managed_sync:',
      '    schedule: manual',
      '    runner: managed',
      '    source: ' + source,
      '    destination: managed',
      ...(via ? ['    via: ' + via] : []),
      '    resources:',
      ...resources.map((resource) => '      - ' + resource),
      '',
    ].join('\\n')
  );
  return projectRoot;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const posthogRoot = writeProject(
  'posthog-project',
  'posthog',
  ['organizations', 'projects', 'events']
);
const posthogProject = await resolveProjectPipelines({ projectRoot: posthogRoot });
assert(posthogProject.extractPipelines[0]?.runner === 'managed', 'PostHog runner changed');
assert(
  JSON.stringify(posthogProject.extractPipelines[0]?.resources) ===
    JSON.stringify([
      { name: 'organizations' },
      { name: 'projects', forEachParent: 'organizations' },
      { name: 'events', forEachParent: 'projects' },
    ]),
  'PostHog for_each resolution changed'
);
const posthogManifest = await generateProjectManifest({
  projectRoot: posthogRoot,
  bobsledVersion: 'packed-test',
});
assert(posthogManifest.pipelines[0]?.kind === 'extract', 'PostHog manifest was not generated');
assert(
  JSON.stringify(posthogManifest.pipelines[0]?.nodes[0]?.resources) ===
    JSON.stringify(['organizations', 'projects', 'events']),
  'PostHog resources were not grouped into one for_each component'
);

const notionRoot = writeProject(
  'notion-project',
  'notion',
  ['pages', 'blocks', 'comments'],
  'rest'
);
const notionProject = await resolveProjectPipelines({ projectRoot: notionRoot });
assert(
  JSON.stringify(notionProject.extractPipelines[0]?.resources) ===
    JSON.stringify([
      { name: 'pages_rest', requestedName: 'pages' },
      { name: 'blocks', forEachParent: 'pages_rest' },
      { name: 'comments_rest', requestedName: 'comments', forEachParent: 'pages_rest' },
    ]),
  'Notion REST entity variants or for_each resolution changed'
);
const notionManifest = await generateProjectManifest({
  projectRoot: notionRoot,
  bobsledVersion: 'packed-test',
});
assert(notionManifest.pipelines[0]?.kind === 'extract', 'Notion manifest was not generated');
assert(
  JSON.stringify(notionManifest.pipelines[0]?.nodes[0]?.resources) ===
    JSON.stringify(['pages_rest', 'blocks', 'comments_rest']),
  'Notion resources were not grouped into one for_each component'
);

async function assertValidationFailure(projectRoot, expectedFragment) {
  try {
    await generateProjectManifest({ projectRoot });
  } catch (error) {
    assert(error instanceof BobsledProjectValidationError, 'Expected BobsledProjectValidationError');
    assert(
      error.issues.some((issue) => issue.message.includes(expectedFragment)),
      'Validation error did not mention ' + expectedFragment
    );
    return;
  }
  throw new Error('Expected project validation to fail for ' + expectedFragment);
}

// Exercise actual Ossie translation while runtime packages are absent. Merely
// importing the manifest API would miss a later lazy runtime dependency.
const ossieRoot = path.join(process.cwd(), 'ossie-project');
mkdirSync(ossieRoot);
writeFileSync(path.join(ossieRoot, 'bobsled.yml'), [
  'destinations:',
  '  warehouse:',
  '    type: duckdb',
  '    db_path: ./data.duckdb',
  'pipelines:',
  '  sales_models:',
  '    type: models',
  '    schedule: manual',
  '    connection: warehouse',
  '    models: [orders]',
  '',
].join('\\n'));
const ossieDocument = {
  version: '0.2.0.dev0',
  name: 'sales',
  datasets: [{
    name: 'orders',
    source: 'data.main.orders',
    description: 'Orders',
    fields: [{
      name: 'order_id',
      expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'order_id' }] },
      custom_extensions: [{
        vendor_name: 'BOBSLED',
        data: JSON.stringify({ build_expression: 'order_id' }),
      }],
    }],
    custom_extensions: [{
      vendor_name: 'BOBSLED',
      data: JSON.stringify({
        extension_version: '1',
        kind: 'derived',
        grain: ['order_id'],
        build: { source: { ref: 'warehouse.raw_orders' }, materialization: { type: 'table' } },
      }),
    }],
  }],
};
writeFileSync(path.join(ossieRoot, 'sales.json'), JSON.stringify(ossieDocument));
const ossieProject = await resolveProjectPipelines({ projectRoot: ossieRoot });
assert(ossieProject.modelPipelines[0]?.models[0] === 'orders', 'Ossie model was not resolved');
const ossieManifest = await generateProjectManifest({ projectRoot: ossieRoot });
assert(ossieManifest.pipelines[0]?.kind === 'models', 'Ossie model manifest was not generated');
assert(ossieManifest.pipelines[0]?.nodes.length === 1, 'Ossie model node was not generated');

const ontologyApi = await import('@bobsled-inc/bobsled-core/ontology');
const nativeOntology = {spec_version: '0.2', type: 'ontology', name: 'sales', ontology: [{concept: 'Order', type: 'EntityType'}]};
assert(ontologyApi.parseOntologyDocument(nativeOntology).name === 'sales', 'Packed ontology parser failed');
const ontologyExport = ontologyApi.exportOntologyDocuments([{path: 'sales.yml', document: nativeOntology}], {ossieVersion: '0.2.0.dev0'});
assert(ontologyExport.ok && ontologyApi.importOntologyDocuments(ontologyExport.files).ok, 'Packed ontology round trip failed');

const { importOssieDocuments, exportOssieDocument } = await import('@bobsled-inc/bobsled-core/model-spec/interchange');
const exchangeDocument = JSON.parse(JSON.stringify(ossieDocument));
const converted = importOssieDocuments({
  documents: [{ path: 'sales.yml', content: JSON.stringify(exchangeDocument) }],
});
assert(converted.ready, 'Packed Ossie import failed: ' + JSON.stringify(converted.diagnostics));
const exchanged = exportOssieDocument({
  project: {
    sources: converted.files.filter((file) => file.document.type === 'source').map((file) => file.document),
    models: converted.files.filter((file) => file.document.type === 'model').map((file) => file.document),
    metrics: converted.files.filter((file) => file.document.type === 'metric').map((file) => file.document),
    relationships: converted.files.filter((file) => file.document.type === 'relationship').map((file) => file.document),
    addresses: { orders: exchangeDocument.datasets[0].source },
  },
  semanticModelName: 'sales',
  selection: { all: true },
  ossieVersion: '0.2.0.dev0',
});
assert(exchanged.ready, 'Packed Ossie export failed: ' + JSON.stringify(exchanged.diagnostics));
assert(exchanged.files[0]?.document.version === '0.2.0.dev0', 'Packed Ossie export used the wrong profile');


ossieDocument.datasets[0].custom_extensions[0].data = '{}';
writeFileSync(path.join(ossieRoot, 'sales.json'), JSON.stringify(ossieDocument));
try {
  await generateProjectManifest({ projectRoot: ossieRoot });
  throw new Error('Malformed Ossie extension was silently accepted');
} catch (error) {
  assert(error.message.includes('extension_version'), 'Malformed Ossie validation was bypassed');
}

await assertValidationFailure(
  writeProject('invalid-source-project', 'missing_source', ['events']),
  'missing_source'
);
await assertValidationFailure(
  writeProject('invalid-resource-project', 'posthog', ['missing_resource']),
  'missing_resource'
);
`
  );
  execFileSync(process.execPath, ['--import', loaderRegistrationPath, validationSmokePath], {
    cwd: installDir,
    stdio: 'inherit',
  });

  // Keep a pnpm consumer fixture alongside the npm packed-install smoke. The
  // reported regression is a peer-resolution problem, so inspect pnpm's
  // concrete snapshot keys rather than relying on runtime imports alone.
  writeFileSync(
    path.join(peerGraphDir, 'package.json'),
    JSON.stringify(
      {
        name: 'bobsled-packed-peer-graph-smoke',
        private: true,
        type: 'module',
        dependencies: {
          '@bobsled-inc/bobsled-core': `file:${path.join(packDir, tarballs[0])}`,
          'better-auth': '1.7.1',
        },
      },
      null,
      2
    ) + '\n'
  );
  execFileSync('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: peerGraphDir,
    env: { ...process.env, npm_config_minimum_release_age: '0' },
    stdio: 'inherit',
  });

  const peerGraphLockfile = readFileSync(path.join(peerGraphDir, 'pnpm-lock.yaml'), 'utf8');
  const betterCallSnapshots = [
    ...peerGraphLockfile.matchAll(/^  (better-call@[^:\n]*\(zod@[^:\n)]*\)):\s*$/gm),
  ].map((match) => match[1]);
  if (betterCallSnapshots.length !== 1) {
    throw new Error(
      `Expected one better-call snapshot with Dogsled and better-auth, found ${betterCallSnapshots.join(', ') || 'none'}`
    );
  }
  if (!betterCallSnapshots[0].includes('(zod@4.')) {
    throw new Error(
      `Expected better-call to resolve against zod 4, found ${betterCallSnapshots[0]}`
    );
  }

  const stagedBobsledManifest = JSON.parse(
    readFileSync(path.join(stageDir, 'package.json'), 'utf8')
  );
  const leakedDependencies = INLINED_AI_DEPENDENCY_NAMES.filter((name) => {
    return (
      stagedBobsledManifest.dependencies?.[name] !== undefined ||
      stagedBobsledManifest.optionalDependencies?.[name] !== undefined ||
      stagedBobsledManifest.peerDependencies?.[name] !== undefined
    );
  });
  if (leakedDependencies.length > 0) {
    throw new Error(
      `Staged Dogsled manifest leaked inlined AI dependencies: ${leakedDependencies.join(', ')}`
    );
  }

  process.stdout.write(
    'Packed catalog and project-validation verification passed' +
      (skipBuild ? ' (using existing build artifacts)' : '') +
      '.\n'
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
