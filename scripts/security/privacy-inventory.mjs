import { readFileSync } from 'node:fs';
import path from 'node:path';

import { listTrackedFiles, repoRoot } from '../ci/shared.mjs';
import { createFinding } from './lib.mjs';

const sourceFiles = listTrackedFiles((filePath) => {
  const relative = path.relative(repoRoot, filePath).split(path.sep).join('/');
  return (
    (relative.includes('/src/') || relative.startsWith('actions/')) &&
    /\.(?:[cm]?[jt]s|tsx)$/.test(relative)
  );
});

const categories = {
  network: /\b(?:fetch|request|Client|Pool|WebSocket)\s*\(|https?:\/\//,
  subprocess: /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/,
  filesystem:
    /\b(?:readFile|writeFile|appendFile|createReadStream|createWriteStream|mkdtemp)\w*\s*\(/,
  environment: /process\.env(?:\.|\[)/,
  logging: /\b(?:fmt\.(?:debug|info|warn|error)|logger\.(?:debug|info|warn|error))\s*\(/,
  temporaryStorage: /\b(?:tmpdir|mkdtemp|temporary|tempDir)\b/i,
};

const inventory = Object.fromEntries(Object.keys(categories).map((name) => [name, []]));
const findings = [];
for (const filePath of sourceFiles) {
  const relative = path.relative(repoRoot, filePath).split(path.sep).join('/');
  const content = readFileSync(filePath, 'utf8');
  for (const [name, pattern] of Object.entries(categories)) {
    if (pattern.test(content)) inventory[name].push(relative);
  }
}

const telemetryPackages = [
  '@sentry/',
  'posthog-js',
  'posthog-node',
  '@segment/analytics',
  '@datadog/browser',
  'newrelic',
];
for (const filePath of listTrackedFiles(
  (candidate) => path.basename(candidate) === 'package.json'
)) {
  const manifest = JSON.parse(readFileSync(filePath, 'utf8'));
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  for (const dependency of Object.keys(dependencies)) {
    if (telemetryPackages.some((prefix) => dependency.startsWith(prefix))) {
      findings.push(
        createFinding({
          tool: 'privacy-inventory',
          rule: 'runtime-telemetry-dependency',
          severity: 'high',
          message: `${manifest.name ?? filePath} depends on telemetry package ${dependency}.`,
          evidence: dependency,
          location: { path: path.relative(repoRoot, filePath) },
          recommendation: 'Remove the package or document and explicitly approve the data flow.',
        })
      );
    }
  }
}

for (const paths of Object.values(inventory)) paths.sort();
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceFileCount: sourceFiles.length,
      categories: Object.fromEntries(
        Object.entries(inventory).map(([name, paths]) => [
          name,
          { count: paths.length, files: paths },
        ])
      ),
      findings,
    },
    null,
    2
  )}\n`
);
if (findings.length > 0) process.exitCode = 1;
