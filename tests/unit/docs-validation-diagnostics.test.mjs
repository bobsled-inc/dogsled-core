import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('describes an unsupported doctor namespace without repeating its internal name', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'docs-diagnostic-'));
  try {
    for (const relative of ['ci/validate-docs.mjs', 'ci/shared.mjs', 'ci/source-files.mjs']) {
      const target = path.join(root, 'scripts', relative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(new URL('../../scripts/' + relative, import.meta.url), target);
    }
    mkdirSync(path.join(root, 'packages'));
    mkdirSync(path.join(root, 'docs/guides'), { recursive: true });
    writeFileSync(path.join(root, 'AGENTS.md'), '<!-- last-reviewed: 2026-10-22 -->\n');
    writeFileSync(path.join(root, 'docs/guides/entity-graph.md'), 'bet2.example\n');
    const result = spawnSync(process.execPath, ['scripts/ci/validate-docs.mjs', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.violations).toContain(
      'docs/guides/entity-graph.md uses an unsupported doctor namespace in user-facing copy.'
    );
    expect(result.stdout).not.toContain('bet2.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
