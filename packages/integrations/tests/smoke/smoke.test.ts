import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, it } from 'vitest';

import { listIntegrationDirs } from '../../src/loader.js';

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(currentDir, '..', '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const legacyCatalogDir = path.join(packageDir, 'integrations');
const smokeScript = path.join(
  repoRoot,
  'packages',
  'extractor',
  'tests',
  'smoke',
  'verify-integration-smoke.ts'
);
const describeSmoke = existsSync(legacyCatalogDir) ? describe : describe.skip;

describeSmoke('integration smoke verification', () => {
  const integrations = listIntegrationDirs();

  for (const name of integrations) {
    describe(name, () => {
      it('passes mock verification', async () => {
        await execFileAsync(
          'pnpm',
          ['--filter', '@bobsled-inc/extractor', 'exec', 'tsx', smokeScript, name],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              FORCE_COLOR: '0',
            },
          }
        );
      }, 120_000);
    });
  }
});
