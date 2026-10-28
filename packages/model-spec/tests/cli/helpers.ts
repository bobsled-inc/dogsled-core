import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PKG_ROOT = path.resolve(import.meta.dirname, '../..');
export const MODEL_SPEC = path.join(PKG_ROOT, 'dist', 'index.js');
export const FIXTURES = path.join(PKG_ROOT, 'tests', 'fixtures', 'specs');
const SPAWN_COMMAND_TIMEOUT_MS = 45_000;

export const CLI_READY = (() => {
  if (!fs.existsSync(MODEL_SPEC)) {
    return false;
  }

  const result = spawnSync('node', [MODEL_SPEC, '--help'], {
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: SPAWN_COMMAND_TIMEOUT_MS,
  });
  return result.status === 0;
})();

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function parseJsonStdout<T>(result: RunResult): T {
  return JSON.parse(result.stdout) as T;
}

export function run(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  input?: string
): RunResult {
  const opts: SpawnSyncOptions = {
    cwd,
    env: { ...process.env, NO_COLOR: '1', ...env },
    input,
    timeout: SPAWN_COMMAND_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  const result = spawnSync('node', [MODEL_SPEC, ...args], opts);
  const spawnError = result.error ? `${result.error.name}: ${result.error.message}` : '';
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: [result.stderr?.toString() ?? '', spawnError].filter(Boolean).join('\n'),
    exitCode: result.status ?? 1,
  };
}

/** Create a temp project directory with copied fixtures.
 *
 * Project integration directories intentionally reject symlinks, so CLI
 * fixtures must model the same physical-tree layout required in production.
 */
export function makeProject(tmpDir: string): string {
  const projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  for (const directory of [
    'sources',
    'models',
    'seeds',
    'integrations',
    'metrics',
    'relationships',
    'vqs',
  ]) {
    fs.cpSync(path.join(FIXTURES, directory), path.join(projectDir, directory), {
      recursive: true,
    });
  }
  return projectDir;
}

export function makeWritableProject(tmpDir: string): string {
  const projectDir = path.join(tmpDir, 'project-copy');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'sources'), path.join(projectDir, 'sources'), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'models'), path.join(projectDir, 'models'), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'seeds'), path.join(projectDir, 'seeds'), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'integrations'), path.join(projectDir, 'integrations'), {
    recursive: true,
  });
  fs.cpSync(path.join(FIXTURES, 'metrics'), path.join(projectDir, 'metrics'), {
    recursive: true,
  });
  fs.cpSync(path.join(FIXTURES, 'relationships'), path.join(projectDir, 'relationships'), {
    recursive: true,
  });
  fs.cpSync(path.join(FIXTURES, 'vqs'), path.join(projectDir, 'vqs'), { recursive: true });
  return projectDir;
}

export function writeRunner(projectDir: string): { logPath: string; runnerPath: string } {
  const logPath = path.join(projectDir, 'runner-log.jsonl');
  const runnerPath = path.join(projectDir, 'runner.mjs');
  fs.writeFileSync(
    runnerPath,
    `import * as fs from 'node:fs';
const logPath = ${JSON.stringify(logPath)};
function append(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n');
}
export default async function run(sql) {
  append({ type: 'run', sql });
  return { rowCount: 1 };
}
export async function query(sql) {
  append({ type: 'query', sql });
  return [];
}
`,
    'utf-8'
  );
  return { logPath, runnerPath };
}

export function readRunnerLog(logPath: string): Array<{ type: string; sql: string }> {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; sql: string });
}
