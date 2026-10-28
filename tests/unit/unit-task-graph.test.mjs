import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('workspace unit test build ordering', () => {
  it('finishes each package build before tests can spawn its compiled CLI', () => {
    const graph = JSON.parse(
      execFileSync(
        'pnpm',
        ['exec', 'turbo', 'run', 'test:unit', '--dry=json', '--filter=!@bobsled-inc/dogsled'],
        {
          cwd: root,
          env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        }
      )
    );
    const tasks = new Map(graph.tasks.map((task) => [task.taskId, task]));
    const units = graph.tasks.filter((task) => task.taskId.endsWith('#test:unit'));
    expect(units.length).toBeGreaterThan(0);
    const missing = units.filter((unit) => {
      const ownBuild = `${unit.package}#build`;
      const pending = [...unit.dependencies];
      const seen = new Set();
      while (pending.length > 0) {
        const id = pending.pop();
        if (id === ownBuild) return false;
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...(tasks.get(id)?.dependencies ?? []));
      }
      return true;
    });
    expect(missing.map((task) => task.taskId)).toEqual([]);
  });
});
