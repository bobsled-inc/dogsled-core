import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceFiles } from './source-files.mjs';

const currentFile = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(currentFile), '..', '..');
export const packagesRoot = path.join(repoRoot, 'packages');
export const rootAgentsPath = path.join(repoRoot, 'AGENTS.md');

export function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

let _workspacePackagesCache;

export function listWorkspacePackages() {
  if (_workspacePackagesCache) {
    return _workspacePackagesCache;
  }

  _workspacePackagesCache = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const packageJsonPath = path.join(packagesRoot, entry.name, 'package.json');
      return existsSync(packageJsonPath);
    })
    .map((entry) => {
      const dir = path.join(packagesRoot, entry.name);
      const packageJsonPath = path.join(dir, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

      return {
        dir,
        name: packageJson.name,
        shortName: entry.name,
        packageJson,
        packageJsonPath,
        agentsPath: path.join(dir, 'AGENTS.md'),
      };
    })
    .sort((left, right) => left.shortName.localeCompare(right.shortName));

  return _workspacePackagesCache;
}

export function findPackageForFile(filePath) {
  const normalized = path.resolve(filePath);
  return listWorkspacePackages().find((pkg) => normalized.startsWith(`${pkg.dir}${path.sep}`));
}

export function pathExists(filePath) {
  return existsSync(filePath);
}

export function createDocPointer(filePath, section) {
  const location = relativeToRepo(filePath);
  return section ? `${location} -> ${section}` : location;
}

export function formatGuidance({ summary, agentsSection, packageDoc, packageSection }) {
  const parts = [summary];
  if (agentsSection) {
    parts.push(`See ${createDocPointer(rootAgentsPath, agentsSection)}.`);
  }
  if (packageDoc) {
    parts.push(`See ${createDocPointer(packageDoc, packageSection)}.`);
  }
  return parts.join(' ');
}

export function listFilesRecursively(rootDir, predicate) {
  const files = [];
  const visit = (currentDir) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.turbo' ||
        entry.name === '.omc' ||
        entry.name === '.security-review'
      ) {
        continue;
      }

      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }

      if (!predicate || predicate(absolutePath)) {
        files.push(absolutePath);
      }
    }
  };

  visit(rootDir);
  return files.sort();
}

export function listTrackedFiles(predicate) {
  return sourceFiles(repoRoot)
    .map((relativePath) => path.join(repoRoot, relativePath))
    .filter((filePath) => !predicate || predicate(filePath))
    .sort();
}

export function parseLastReviewed(text) {
  const match = text.match(/last-reviewed:\s*(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function isRepoRelativeToken(token) {
  return (
    token === 'AGENTS.md' ||
    token === 'package.json' ||
    token === 'pnpm-workspace.yaml' ||
    token === 'turbo.json' ||
    token === 'eslint.config.base.mjs' ||
    token === 'tsconfig.base.json' ||
    token.startsWith('packages/') ||
    token.startsWith('docs/') ||
    token.startsWith('.github/') ||
    token.startsWith('.agents/') ||
    token.startsWith('scripts/')
  );
}

export function isPackageRelativeToken(token) {
  if (
    token === 'AGENTS.md' ||
    token === 'README.md' ||
    token === 'package.json' ||
    token === 'tsconfig.json' ||
    token === 'tsup.config.ts' ||
    token === 'eslint.config.mjs' ||
    token === 'vitest.config.ts'
  ) {
    return true;
  }

  return (
    token.startsWith('src/') ||
    token.startsWith('tests/') ||
    token.startsWith('integrations/') ||
    token.startsWith('scripts/')
  );
}

export function normalizeDocToken(token) {
  return token.replace(/[.,:;)]$/, '').replace(/^\.\//, '');
}

export function isConcreteDocToken(token) {
  return !/[<>{}*|]/.test(token);
}
