import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';

import { loadAllowList, scanFile, staleExceptions } from '../../scripts/guards/old-names.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const allow = loadAllowList();
const count = (file, text) =>
  Object.fromEntries(
    [...scanFile(file, text.split('\n'), allow)].map(([id, rows]) => [id, rows.length])
  );
const guard = (...args) =>
  spawnSync(process.execPath, ['scripts/guards/old-names.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  });

describe('old-name guard', () => {
  it('counts old names in content, warehouse prefixes and paths', () => {
    expect(
      count('docs/a.md', 'Run dogsled extract with DOGSLED_X in Dogsled.')['dogsled-word']
    ).toBe(3);
    expect(
      count('docs/a.md', 'SELECT _dogsled_loaded_at, __track_cursors')['old-warehouse-prefix']
    ).toBe(2);
    expect(count('packages/dogsled/src/a.ts', '')['dogsled-path']).toBe(1);
    expect(count('packages/bobsled-core/src/a.ts', 'bobsled_api and Bobsled Core')).toEqual({
      'dogsled-word': 0,
      'old-warehouse-prefix': 0,
      'track-config': 0,
      'track-env': 0,
      'track-kind': 0,
      'dogsled-path': 0,
    });
  });

  it('watches Track-era config, settings and kinds', () => {
    const counts = count(
      'docs/a.md',
      "track.yml in .track/state, TRACK_PIPELINE_COMMAND, kind: 'track.model.run'; tracking and track_total_hits"
    );
    expect([counts['track-config'], counts['track-env'], counts['track-kind']]).toEqual([2, 1, 1]);
  });

  it('reports exceptions that no longer match as stale (a kept old name was deleted)', () => {
    const allowList = loadAllowList({
      version: 1,
      keep: [],
      exceptions: [
        {
          path: 'src/legacy-names.ts',
          patternId: 'dogsled-word',
          pattern: "'dogsled\\.model\\.run'",
          reason: 'Run kind reader.',
        },
        {
          path: 'src/gone.ts',
          patternId: 'dogsled-word',
          pattern: 'dogsled',
          reason: 'File removed.',
        },
      ],
    });
    const files = { 'src/legacy-names.ts': "export const KINDS = ['bobsled.model.run'];" };
    const stale = staleExceptions(allowList, (file) => files[file] ?? null);
    expect(stale.map((entry) => entry.path)).toEqual(['src/legacy-names.ts', 'src/gone.ts']);
    files['src/legacy-names.ts'] =
      "export const KINDS = ['dogsled.model.run', 'bobsled.model.run'];";
    expect(staleExceptions(allowList, (file) => files[file] ?? null)).toHaveLength(1);
  });

  it('has no stale exceptions in the committed allow list', () => {
    expect(staleExceptions(allow)).toEqual([]);
  });

  it('allows the keep list, and file-limited entries only in their files', () => {
    expect(count('docs/a.md', 'Dogsled Cloud at https://main.dogsled.it')['dogsled-word']).toBe(0);
    expect(count('docs/a.md', 'comment on @dogsled/lakehouse-execution')['dogsled-word']).toBe(0);
    const policyHost = 'https://dogsledai.com';
    expect(count('tests/unit/security-runtime-policy.test.mjs', policyHost)['dogsled-word']).toBe(
      0
    );
    expect(count('docs/a.md', policyHost)['dogsled-word']).toBe(1);
    expect(count('docs/a.md', 'Dogsled Cloud and dogsled')['dogsled-word']).toBe(1);
  });

  it('rejects malformed allow lists', () => {
    expect(() =>
      loadAllowList({ version: 1, keep: [{ pattern: 'bobsled', note: 'x' }], exceptions: [] })
    ).toThrow();
    expect(() => loadAllowList({ version: 1, keep: [], exceptions: [{ path: 'a' }] })).toThrow();
    expect(() => loadAllowList({ version: 2, keep: [], exceptions: [] })).toThrow();
  });

  it('reports without failing by default, and fails in strict mode', () => {
    const report = guard();
    expect(report.status).toBe(0);
    expect(report.stdout).toMatch(/Old-name guard \(report only\): \d+ findings/);
    const findings = Number(report.stdout.match(/: (\d+) findings/)[1]);
    expect(guard('--strict').status).toBe(findings > 0 ? 1 : 0);
  }, 30_000);

  it('runs report-only in CI until the rename is done', () => {
    const ci = parse(readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
    const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
    const step = ci.jobs.checks.steps.find((s) => s.run === 'pnpm guard:dogsled');
    expect(step).toBeDefined();
    expect(scripts['guard:dogsled']).toBe('node ./scripts/guards/old-names.mjs');
  });
});
