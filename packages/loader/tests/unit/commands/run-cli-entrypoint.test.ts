import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../../..');
const LOADER_ENTRYPOINT = path.join(PACKAGE_ROOT, 'src', 'index.ts');
const require = createRequire(import.meta.url);
const TSX_LOADER = require.resolve('tsx/esm', { paths: [PACKAGE_ROOT] });
const WIF_ENV_NAME = 'LOADER_TEST_SNOWFLAKE_WIF_TOKEN';
const WIF_REFERENCE = `$${WIF_ENV_NAME}`;

function runLoaderEntrypoint(reference: string, envValue?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env[WIF_ENV_NAME];
  if (envValue !== undefined) {
    env[WIF_ENV_NAME] = envValue;
  }

  return spawnSync(
    process.execPath,
    [
      '--no-deprecation',
      '--import',
      TSX_LOADER,
      LOADER_ENTRYPOINT,
      'run',
      '--dest',
      'snowflake',
      '--sf-account',
      'acct',
      '--sf-username',
      'loader',
      '--sf-warehouse',
      'WH',
      '--sf-database',
      'DB',
      '--sf-workload-identity-token',
      reference,
    ],
    {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env,
      input: '',
      timeout: 20_000,
    }
  );
}

describe('loader entrypoint Snowflake workload identity errors', () => {
  it.each([
    {
      caseName: 'literal token',
      reference: 'literal-wif-token-entrypoint-sentinel',
      expectedStderr:
        'Snowflake workload identity token must be an environment variable reference.\n',
    },
    {
      caseName: 'malformed reference',
      reference: '$LOADER-WIF-TOKEN',
      expectedStderr:
        'Snowflake workload identity token must be an environment variable reference.\n',
    },
    {
      caseName: 'unset reference',
      reference: WIF_REFERENCE,
      expectedStderr: 'Snowflake workload identity token environment variable is not set.\n',
    },
    {
      caseName: 'blank reference',
      reference: WIF_REFERENCE,
      envValue: '',
      expectedStderr: 'Snowflake workload identity token must be non-empty.\n',
    },
  ])(
    'exits 2 with token-free stderr and no stdout for a $caseName',
    ({ reference, envValue, expectedStderr }) => {
      const result = runLoaderEntrypoint(reference, envValue);

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(expectedStderr);
      expect(result.stderr).not.toContain(reference);
    }
  );
});
