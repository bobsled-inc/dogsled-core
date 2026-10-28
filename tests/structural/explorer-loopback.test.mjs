import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { listTrackedFiles, relativeToRepo } from '../../scripts/ci/shared.mjs';
import { createNextArgs } from '../../apps/explorer/scripts/next-dev.mjs';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

describe('Explorer launch boundary', () => {
  it('binds every direct Next.js launch script to a numeric loopback address', () => {
    const explorer = JSON.parse(read('apps/explorer/package.json'));
    expect(explorer.scripts.dev).toBe('node ./scripts/next-dev.mjs');
    expect(explorer.scripts.start).toBe('next start --hostname 127.0.0.1 --port 3333');
    let directLaunches = 0;
    for (const file of listTrackedFiles((candidate) => candidate.endsWith('/package.json'))) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (!/\bnext\s+(?:dev|start)\b/.test(command)) continue;
        directLaunches++;
        expect(command, `${relativeToRepo(file)}:${name}`).toMatch(
          /(?:--hostname|-H)(?:=|\s+)(?:127\.0\.0\.1|::1)(?:\s|$)/
        );
        expect(command, name).not.toMatch(/(?:0\.0\.0\.0|--hostname\s+localhost)/);
      }
    }
    expect(directLaunches).toBeGreaterThan(0);
  });

  it('keeps programmatic launches on the reviewed loopback launcher', () => {
    const launches = [];
    for (const file of listTrackedFiles((candidate) =>
      /\.(?:mjs|cjs|js|ts|tsx)$/.test(candidate)
    )) {
      const relative = relativeToRepo(file);
      if (/\.test\./.test(relative)) continue;
      const source = readFileSync(file, 'utf8');
      if (/\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*['"]next['"]/.test(source)) {
        expect(relative).toBe('apps/explorer/scripts/next-dev.mjs');
        expect(source).toContain("spawn('next', createNextArgs(");
        launches.push(relative);
      }
      expect(source, relative).not.toMatch(/next\/dist\/bin\/next/);
      if (source.includes('scripts/next-dev.mjs')) {
        expect(relative).toBe('examples/explorer-smoke/showcase.mjs');
        expect(source).not.toMatch(/['"](?:--hostname|-H)(?:=|['"])/);
        launches.push(relative);
      }
    }
    expect(launches.sort()).toEqual([
      'apps/explorer/scripts/next-dev.mjs',
      'examples/explorer-smoke/showcase.mjs',
    ]);
    expect(createNextArgs(3333, [])).toEqual(['dev', '--port', '3333', '-H', '127.0.0.1']);
    expect(() => createNextArgs(3333, ['--hostname', '0.0.0.0'])).toThrow(/local-only/);
  });
});
