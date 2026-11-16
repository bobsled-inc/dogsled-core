import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { CommandError } from '@bobsled-inc/protocol';
import type { CommandInvocation } from './process.js';

export type CliTarget = 'extract' | 'load' | 'model' | 'entity-graph' | 'embed';

const MAX_TRAVERSAL_DEPTH = 20;
const require = createRequire(import.meta.url);

function resolveTsxImportPath(): string {
  try {
    return require.resolve('tsx/esm');
  } catch {
    throw new CommandError(
      'tsx is not available. Run `npm install tsx` or use the compiled dist version.'
    );
  }
}

const workspaceRootCache = new Map<string, string | null>();

interface CandidateEntry {
  pathSegments: string[];
  useTsx: boolean;
}

const CLI_CANDIDATES: Record<CliTarget, CandidateEntry[]> = {
  extract: [
    { pathSegments: ['packages', 'extractor', 'src', 'index.ts'], useTsx: true },
    { pathSegments: ['packages', 'extractor', 'dist', 'index.js'], useTsx: false },
  ],
  load: [
    { pathSegments: ['packages', 'loader', 'src', 'index.ts'], useTsx: true },
    { pathSegments: ['packages', 'loader', 'dist', 'index.js'], useTsx: false },
  ],
  model: [
    { pathSegments: ['packages', 'model-spec', 'src', 'index.ts'], useTsx: true },
    { pathSegments: ['packages', 'model-spec', 'dist', 'index.js'], useTsx: false },
  ],
  'entity-graph': [
    { pathSegments: ['packages', 'entity-graph', 'src', 'index.ts'], useTsx: true },
    { pathSegments: ['packages', 'entity-graph', 'dist', 'cli.js'], useTsx: false },
  ],
  embed: [
    { pathSegments: ['packages', 'embedder', 'src', 'index.ts'], useTsx: true },
    { pathSegments: ['packages', 'embedder', 'dist', 'index.js'], useTsx: false },
  ],
};

// entity-graph builds its library as dist/index.js and its CLI as dist/cli.js;
// the other delegated packages build their CLI as dist/index.js.
const INSTALLED_CLI_ENTRY: Record<CliTarget, string> = {
  extract: 'index.js',
  load: 'index.js',
  model: 'index.js',
  'entity-graph': 'cli.js',
  embed: 'index.js',
};

const INSTALLED_PACKAGE_NAMES: Record<CliTarget, string> = {
  extract: '@bobsled-inc/extractor',
  load: '@bobsled-inc/loader',
  model: '@bobsled-inc/model-spec',
  'entity-graph': '@bobsled-inc/entity-graph',
  embed: '@bobsled-inc/embedder',
};

const DOGSLED_MODEL_RUN_CANDIDATES: CandidateEntry[] = [
  { pathSegments: ['packages', 'bobsled-core', 'src', 'commands', 'model-run.ts'], useTsx: true },
  { pathSegments: ['packages', 'bobsled-core', 'dist', 'commands', 'model-run.js'], useTsx: false },
];

export function tryFindWorkspaceRoot(metaUrl: string): string | null {
  const cached = workspaceRootCache.get(metaUrl);
  if (cached !== undefined) {
    return cached;
  }

  let currentDir = path.dirname(fileURLToPath(metaUrl));

  for (let depth = 0; depth < MAX_TRAVERSAL_DEPTH; depth++) {
    if (fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      workspaceRootCache.set(metaUrl, currentDir);
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  workspaceRootCache.set(metaUrl, null);
  return null;
}

export function findWorkspaceRoot(metaUrl: string): string {
  const workspaceRoot = tryFindWorkspaceRoot(metaUrl);
  if (!workspaceRoot) {
    throw new CommandError('Unable to locate the workspace root for the unified dogsled CLI.');
  }
  return workspaceRoot;
}

function resolveInstalledCliPath(target: CliTarget, metaUrl: string): string | null {
  const packagePathSegments = INSTALLED_PACKAGE_NAMES[target].split('/');
  let currentDir = path.dirname(fileURLToPath(metaUrl));

  for (let depth = 0; depth < MAX_TRAVERSAL_DEPTH; depth++) {
    const stagedCliPath = path.join(
      currentDir,
      'node_modules',
      ...packagePathSegments,
      'dist',
      INSTALLED_CLI_ENTRY[target]
    );
    if (fs.existsSync(stagedCliPath)) {
      return fs.realpathSync(stagedCliPath);
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

function invocationForCandidate(
  absolutePath: string,
  useTsx: boolean,
  cliArgs: string[],
  resolveTsxImportPathFn: () => string
): CommandInvocation {
  if (!useTsx) {
    return {
      command: process.execPath,
      args: [absolutePath, ...cliArgs],
    };
  }

  return {
    command: process.execPath,
    args: ['--import', resolveTsxImportPathFn(), absolutePath, ...cliArgs],
  };
}

export function resolveCliInvocation(
  target: CliTarget,
  metaUrl: string,
  cliArgs: string[],
  resolveTsxImportPathFn: () => string = resolveTsxImportPath
): CommandInvocation {
  const workspaceRoot = tryFindWorkspaceRoot(metaUrl);
  if (workspaceRoot) {
    const workspaceCandidates = CLI_CANDIDATES[target].map((entry) => ({
      absolutePath: path.join(workspaceRoot, ...entry.pathSegments),
      useTsx: entry.useTsx,
    }));

    for (const workspaceCandidate of workspaceCandidates) {
      if (!fs.existsSync(workspaceCandidate.absolutePath)) {
        continue;
      }

      try {
        return invocationForCandidate(
          workspaceCandidate.absolutePath,
          workspaceCandidate.useTsx,
          cliArgs,
          resolveTsxImportPathFn
        );
      } catch {
        continue;
      }
    }

    throw new CommandError(`Unable to locate the ${target} CLI in this workspace.`);
  }

  const installedCliPath = resolveInstalledCliPath(target, metaUrl);
  if (installedCliPath) {
    return {
      command: process.execPath,
      args: [installedCliPath, ...cliArgs],
    };
  }

  throw new CommandError(
    `Unable to locate the ${target} CLI for the unified dogsled CLI. Reinstall dogsled or run it from the repository workspace.`
  );
}

export function resolveBobsledModelRunInvocation(
  metaUrl: string,
  cliArgs: string[],
  resolveTsxImportPathFn: () => string = resolveTsxImportPath
): CommandInvocation {
  const workspaceRoot = tryFindWorkspaceRoot(metaUrl);
  if (workspaceRoot) {
    for (const candidate of DOGSLED_MODEL_RUN_CANDIDATES) {
      const absolutePath = path.join(workspaceRoot, ...candidate.pathSegments);
      if (!fs.existsSync(absolutePath)) continue;

      try {
        return invocationForCandidate(
          absolutePath,
          candidate.useTsx,
          cliArgs,
          resolveTsxImportPathFn
        );
      } catch {
        continue;
      }
    }

    throw new CommandError('Unable to locate the Dogsled model run child CLI in this workspace.');
  }

  let currentDir = path.dirname(fileURLToPath(metaUrl));
  for (let depth = 0; depth < MAX_TRAVERSAL_DEPTH; depth++) {
    const candidatePath = path.join(currentDir, 'commands', 'model-run.js');
    if (fs.existsSync(candidatePath)) {
      return {
        command: process.execPath,
        args: [fs.realpathSync(candidatePath), ...cliArgs],
      };
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  throw new CommandError(
    'Unable to locate the Dogsled model run child CLI. Reinstall dogsled or run it from the repository workspace.'
  );
}
