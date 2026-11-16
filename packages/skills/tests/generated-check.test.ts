import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { findGeneratedDrift } from '../scripts/check-generated.js';
import { REPO_ROOT } from '../scripts/build-plugins.js';

const skillPath = 'plugins/bobsled-core/skills/example/SKILL.md';
const catalogPath = '.agents/plugins/marketplace.json';

function fixture(run: (root: string, expected: Record<string, string>) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'bobsled-generated-check-'));
  const expected = { [skillPath]: 'Current skill\n', [catalogPath]: '{}\n' };
  try {
    for (const [path, content] of Object.entries(expected)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    run(root, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('generated skill check before builds', () => {
  it('accepts current output and reports changed source output without repairing files', () => {
    fixture((root, expected) => {
      expect(findGeneratedDrift(root, expected)).toEqual([]);
      const updated = { ...expected, [skillPath]: 'New source guidance\n' };
      expect(findGeneratedDrift(root, updated)).toEqual([skillPath]);
      expect(readFileSync(join(root, skillPath), 'utf8')).toBe(expected[skillPath]);
    });
  });

  it('detects missing files, including a new skill not yet generated', () => {
    fixture((root, expected) => {
      rmSync(join(root, catalogPath));
      const newSkill = 'plugins/bobsled-core/skills/new-skill/SKILL.md';
      expect(findGeneratedDrift(root, { ...expected, [newSkill]: 'New skill\n' })).toEqual(
        [catalogPath, newSkill].sort()
      );
    });
  });

  it('detects removed skills and unexpected non-Markdown support files', () => {
    fixture((root, expected) => {
      const extra = 'plugins/bobsled-core/skills/example/stale.js';
      writeFileSync(join(root, extra), 'stale');
      expect(findGeneratedDrift(root, { [catalogPath]: expected[catalogPath]! })).toEqual(
        [skillPath, extra].sort()
      );
    });
  });

  it('rejects symlinked output even when it points to matching text', () => {
    fixture((root, expected) => {
      const target = join(root, 'target.md');
      writeFileSync(target, expected[skillPath]!);
      rmSync(join(root, skillPath));
      symlinkSync(target, join(root, skillPath));
      expect(findGeneratedDrift(root, expected)).toEqual([skillPath]);
    });
  });

  it('runs directly before builds in CI and the local precommit gate', () => {
    const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
    const commands = workflow.jobs.checks.steps.map((step: { run?: string }) => step.run);
    expect(commands.indexOf('pnpm skills:check')).toBeGreaterThan(
      commands.indexOf('pnpm install --frozen-lockfile')
    );
    expect(commands.indexOf('pnpm skills:check')).toBeLessThan(commands.indexOf('pnpm build'));
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.precommit).toMatch(/^pnpm skills:check && pnpm build/);
    expect(pkg.scripts['skills:check']).toBe('pnpm --filter @bobsled-inc/skills check:generated');
  });
});
