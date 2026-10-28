import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadIntegrationSpec, loadResourceSpec } from '../../src/commands/common.js';
import { runMockVerification } from '../../src/commands/verify-mock.js';

import type { ApiIntegrationSpec, HttpApiResourceSpec } from '../../src/types/index.js';

const integrationName = process.argv[2];
if (!integrationName) {
  throw new Error('Expected integration name argument');
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..');
const integrationDir = path.join(
  repoRoot,
  'packages',
  'integrations',
  'integrations',
  integrationName
);

const integration = loadIntegrationSpec(
  path.join(integrationDir, 'integration.yml')
) as ApiIntegrationSpec;

const resources = fs
  .readdirSync(path.join(integrationDir, 'resources'))
  .filter((fileName) => fileName.endsWith('.yml'))
  .map((fileName) =>
    loadResourceSpec(path.join(integrationDir, 'resources', fileName))
  ) as HttpApiResourceSpec[];

const result = await runMockVerification(integrationName, integration, resources);
const errorFindings = result.findings.filter((finding) => finding.severity === 'error');

if (errorFindings.length > 0) {
  for (const finding of errorFindings) {
    const resourceLabel = finding.resource ? `${finding.resource}: ` : '';
    process.stderr.write(`${finding.code} ${resourceLabel}${finding.message}\n`);
  }
  process.exitCode = 1;
}
