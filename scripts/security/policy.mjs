import { readFileSync } from 'node:fs';
import path from 'node:path';

import { listTrackedFiles, listWorkspacePackages, repoRoot } from '../ci/shared.mjs';
import { createFinding } from './lib.mjs';

const runtimeExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const telemetryImport =
  /(?:from\s+|require\()['"](?:@sentry\/|posthog(?:-js|-node)?|@segment\/analytics|@datadog\/browser|newrelic|mixpanel-browser)/i;
const bobsledEndpoint =
  /https?:\/\/(?:api\.|telemetry\.|events\.)?(?:bobsled\.(?:co|ai|cloud)|dogsledai\.com|dogsled\.(?:co|ai|cloud|com|it))(?![a-z0-9_.-])/i;
const privateRegistry = /(?:pkg\.dev\/bobsled|npm\.pkg\.github\.com\/download\/@bobsled-inc)/i;

const findings = [];
for (const filePath of listTrackedFiles((candidate) =>
  runtimeExtensions.has(path.extname(candidate))
)) {
  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join('/');
  if (!relativePath.includes('/src/') && !relativePath.startsWith('actions/')) continue;
  const content = readFileSync(filePath, 'utf8');

  if (telemetryImport.test(content)) {
    findings.push(
      createFinding({
        tool: 'dogsled-policy',
        rule: 'undeclared-runtime-telemetry',
        severity: 'high',
        message: 'Runtime source imports an analytics or telemetry SDK.',
        evidence: relativePath,
        location: { path: relativePath },
        recommendation: 'Document and explicitly approve the data flow, or remove the dependency.',
      })
    );
  }
  if (bobsledEndpoint.test(content)) {
    findings.push(
      createFinding({
        tool: 'dogsled-policy',
        rule: 'bobsled-operated-runtime-endpoint',
        severity: 'high',
        message: 'Runtime source contains a Bobsled-operated endpoint.',
        evidence: relativePath,
        location: { path: relativePath },
        recommendation: 'Remove the endpoint or document the explicit operator-controlled egress.',
      })
    );
  }
  if (privateRegistry.test(content)) {
    findings.push(
      createFinding({
        tool: 'dogsled-policy',
        rule: 'private-runtime-registry',
        severity: 'high',
        message: 'Runtime source references a retired private package registry.',
        evidence: relativePath,
        location: { path: relativePath },
      })
    );
  }
}

for (const pkg of listWorkspacePackages().filter(
  (candidate) => candidate.packageJson.private !== true
)) {
  const scripts = pkg.packageJson.scripts ?? {};
  for (const lifecycle of [
    'preinstall',
    'install',
    'postinstall',
    'prepublish',
    'prepublishOnly',
    'prepack',
    'postpack',
  ]) {
    if (scripts[lifecycle] !== undefined) {
      findings.push(
        createFinding({
          tool: 'dogsled-policy',
          rule: 'published-lifecycle-script',
          severity: 'high',
          message: `${pkg.name} declares the ${lifecycle} lifecycle script.`,
          evidence: `${pkg.shortName}/package.json`,
          location: { path: path.relative(repoRoot, pkg.packageJsonPath) },
          recommendation: 'Remove the lifecycle script or require explicit security review.',
        })
      );
    }
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      checkedFiles: listTrackedFiles().length,
      checkedPackages: listWorkspacePackages().length,
      findings,
    },
    null,
    2
  )}\n`
);
if (findings.length > 0) process.exitCode = 1;
