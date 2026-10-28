import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const PKG_ROOT = path.resolve(import.meta.dirname, '../..');
const ENTITY_GRAPH_CLI = path.join(PKG_ROOT, 'dist', 'cli.js');
const ENTITY_GRAPH_SRC = path.join(PKG_ROOT, 'src', 'index.ts');
const require = createRequire(import.meta.url);
const ENTITY_GRAPH_FIXTURES = path.resolve(PKG_ROOT, 'tests/fixtures/specs');
const SHARED_FIXTURE_DIRS = ['sources', 'models', 'seeds'] as const;
const ENTITY_GRAPH_FIXTURE_DIRS = ['resolutions'] as const;
const SHARED_FIXTURE_CANDIDATES = [
  path.resolve(PKG_ROOT, '../model-spec/tests/fixtures/specs'),
  path.resolve(PKG_ROOT, '../../model-spec/tests/fixtures/specs'),
  path.resolve(PKG_ROOT, '../entity-graph/tests/fixtures/specs'),
] as const;

function hasFixtureDirs(fixtureRoot: string, dirs: readonly string[]): boolean {
  return dirs.every((segment) => fs.existsSync(path.join(fixtureRoot, segment)));
}

const SHARED_FIXTURES = (() => {
  return SHARED_FIXTURE_CANDIDATES.find((candidate) =>
    hasFixtureDirs(candidate, SHARED_FIXTURE_DIRS)
  );
})();

const FIXTURES_READY = Boolean(
  SHARED_FIXTURES &&
  hasFixtureDirs(ENTITY_GRAPH_FIXTURES, ENTITY_GRAPH_FIXTURE_DIRS) &&
  fs.existsSync(ENTITY_GRAPH_FIXTURES)
);
function describeFixturesError() {
  const candidatePaths = SHARED_FIXTURE_CANDIDATES.map((candidate) => `- ${candidate}`).join('\n');

  return `Required entity graph test fixtures were not found.
Checked:
${candidatePaths}
and project entity graph fixtures: ${ENTITY_GRAPH_FIXTURES}`;
}

function resolveTsxLoader(): string {
  return require.resolve('tsx/esm', { paths: [PKG_ROOT] });
}

function resolveCliBaseArgs(): string[] {
  if (fs.existsSync(ENTITY_GRAPH_CLI)) {
    return [ENTITY_GRAPH_CLI];
  }

  return ['--import', resolveTsxLoader(), ENTITY_GRAPH_SRC];
}

const CLI_BASE_ARGS = resolveCliBaseArgs();
const SPAWN_COMMAND_TIMEOUT_MS = 45_000;
export const CLI_READY = (() => {
  if (!FIXTURES_READY) {
    return false;
  }
  const result = spawnSync('node', [...CLI_BASE_ARGS, '--help'], {
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: SPAWN_COMMAND_TIMEOUT_MS,
  });
  return result.status === 0;
})();

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function parseJsonStdout<T>(result: RunResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON stdout:\n${result.stdout}\n${message}`);
  }
}

export function run(args: string[], cwd: string, env?: Record<string, string>): RunResult {
  const opts: SpawnSyncOptions = {
    cwd,
    env: { ...process.env, NO_COLOR: '1', ...env },
    timeout: SPAWN_COMMAND_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  const result = spawnSync('node', [...CLI_BASE_ARGS, ...args], opts);
  const spawnError = result.error ? `${result.error.name}: ${result.error.message}` : '';
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: [result.stderr?.toString() ?? '', spawnError].filter(Boolean).join('\n'),
    exitCode: result.status ?? 1,
  };
}

export function makeProject(tmpDir: string): string {
  if (!FIXTURES_READY || !SHARED_FIXTURES) {
    throw new Error(describeFixturesError());
  }

  // Copies, not links: Dogsled refuses symbolic links inside a project.
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.cpSync(path.join(SHARED_FIXTURES, 'sources'), path.join(projectDir, 'sources'), {
    recursive: true,
  });
  fs.cpSync(path.join(SHARED_FIXTURES, 'models'), path.join(projectDir, 'models'), {
    recursive: true,
  });
  fs.cpSync(
    path.join(ENTITY_GRAPH_FIXTURES, 'resolutions'),
    path.join(projectDir, 'entity-graph'),
    {
      recursive: true,
    }
  );
  fs.cpSync(path.join(SHARED_FIXTURES, 'seeds'), path.join(projectDir, 'seeds'), {
    recursive: true,
  });
  return projectDir;
}
