/** Check generated files without rewriting them or relying on the build cache. */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderGeneratedDataModule } from './build-manifest.js';
import { renderPluginFiles, REPO_ROOT } from './build-plugins.js';

const SKILL_TREE = 'plugins/bobsled-core/skills';

export function expectedGeneratedFiles(): Record<string, string> {
  return {
    ...renderPluginFiles(),
    'packages/skills/src/generated-data.ts': renderGeneratedDataModule(),
  };
}

/** In CI, the checkout contains exactly the files committed in the pull request. */
export function findGeneratedDrift(root: string, expected: Record<string, string>): string[] {
  const drift = new Set<string>();
  for (const [path, content] of Object.entries(expected)) {
    const absolute = join(root, path);
    if (
      !existsSync(absolute) ||
      !lstatSync(absolute).isFile() ||
      readFileSync(absolute, 'utf8') !== content
    ) {
      drift.add(path);
    }
  }
  // Compare the entire managed tree, including obsolete and non-Markdown files.
  const visit = (path: string): void => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (!Object.hasOwn(expected, child) || !entry.isFile()) drift.add(child);
    }
  };
  if (existsSync(join(root, SKILL_TREE))) {
    if (lstatSync(join(root, SKILL_TREE)).isDirectory()) visit(SKILL_TREE);
    else drift.add(SKILL_TREE);
  }
  return [...drift].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const drift = findGeneratedDrift(REPO_ROOT, expectedGeneratedFiles());
  if (drift.length > 0) {
    process.stderr.write(
      `Generated Bobsled Core skills are out of date:\n${drift.map((path) => `- ${path}`).join('\n')}\n` +
        'Run pnpm --filter @bobsled-inc/skills generate:manifest and commit the generated files.\n'
    );
    process.exitCode = 3;
  }
}
