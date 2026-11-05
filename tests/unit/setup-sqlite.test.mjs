import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const rootPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);

it.each([
  [0, 1, 0],
  [2, 3, 0],
  [9, 3, 1],
])(
  'handles %i failed SQLite downloads with %i attempts and exit %i',
  (failures, attempts, status) => {
    const root = mkdtempSync(join(tmpdir(), 'dogsled-sqlite-'));
    try {
      const pkg = join(root, 'node_modules/.pnpm/better-sqlite3@0.0.0/node_modules/better-sqlite3');
      mkdirSync(join(pkg, 'node_modules/.bin'), { recursive: true });
      writeFileSync(
        join(pkg, 'node_modules/.bin/prebuild-install'),
        `#!/bin/sh\nn=0\n[ ! -f attempts ] || n=$(cat attempts)\nn=$((n + 1))\necho "$n" > attempts\n[ "$n" -gt ${failures} ]\n`,
        { mode: 0o755 }
      );
      const result = spawnSync('sh', ['-c', rootPackage.scripts['setup:sqlite']], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(status);
      expect(Number(readFileSync(join(pkg, 'attempts'), 'utf8'))).toBe(attempts);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
