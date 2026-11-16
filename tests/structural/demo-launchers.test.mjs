import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../../scripts/ci/shared.mjs';

const launchers = [
  'packages/model-spec/tests/integration/customer-resolution/scripts/install-and-run-latest-cli.sh',
  'packages/model-spec/tests/integration/customer-resolution-claude-code/scripts/_common.sh',
];

describe('customer-resolution demo launchers', () => {
  for (const launcher of launchers) {
    it(`${launcher} uses valid shell syntax and the current setup contract`, () => {
      const file = path.join(repoRoot, launcher);
      const source = readFileSync(file, 'utf8');
      const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
      const cliPackage = JSON.parse(
        readFileSync(path.join(repoRoot, 'packages/bobsled-core/package.json'), 'utf8')
      );

      execFileSync('bash', ['-n', file]);
      expect(source).toContain("import('@duckdb/node-api')");
      expect(source).toContain('pnpm --dir "$REPO_ROOT" run setup');
      expect(source).not.toContain('setup:duckdb');
      for (const match of source.matchAll(/pnpm --dir "\$REPO_ROOT" run ([\w:-]+)/g)) {
        expect(rootPackage.scripts[match[1]], match[1]).toBeTruthy();
      }
      expect(rootPackage.scripts.setup).toBeTruthy();
      expect(cliPackage.scripts.build).toBeTruthy();
      expect(cliPackage.dependencies['@duckdb/node-api']).toBeTruthy();
      expect(source).toContain('packages/bobsled-core/dist/index.js');
    });
  }
});
