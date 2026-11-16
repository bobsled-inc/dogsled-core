import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const cliPath = path.resolve(
  process.env.BOBSLED_CORE_E2E_CLI ?? path.join(root, 'packages/bobsled-core/bin/cli.mjs')
);
const require = createRequire(cliPath);

export function isolatedEnv(home, overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: os.tmpdir(),
    CI: '1',
    NO_COLOR: '1',
    BOBSLED_CORE_OUTPUT_FORMAT: 'json',
    ...overrides,
  };
}

export function jsonLines(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
}

export async function publicApi(subpath) {
  return import(pathToFileURL(require.resolve(`@bobsled-inc/bobsled-core/${subpath}`)).href);
}

export async function command(executable, args, options = {}) {
  const { cwd, env, input = '', timeout = 90_000, expected = 0 } = options;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let failure;
    const stop = (message) => {
      failure = new Error(message);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => stop(`Command timed out after ${timeout}ms`), timeout);
    child.stdout.on('data', (chunk) => {
      if (options.stream) process.stdout.write(chunk);
      stdout += chunk;
      if (stdout.length > 8_000_000) stop('stdout limit exceeded');
    });
    child.stderr.on('data', (chunk) => {
      if (options.stream) process.stderr.write(chunk);
      stderr += chunk;
      if (stderr.length > 8_000_000) stop('stderr limit exceeded');
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
  if (expected !== null) {
    assert.equal(
      result.code,
      expected,
      `${path.basename(executable)} ${args.slice(1, 4).join(' ')}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result;
}

export async function context(name) {
  const project = await mkdtemp(path.join(os.tmpdir(), `dogsled-e2e-${name}-`));
  const home = path.resolve(
    process.env.BOBSLED_CORE_E2E_HOME ?? path.join(root, 'test-results/e2e/home')
  );
  await mkdir(home, { recursive: true });
  const env = isolatedEnv(home);
  const outputs = [];
  const ctx = {
    project,
    env,
    outputs,
    async write(relative, content) {
      const destination = path.join(project, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(
        destination,
        typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`
      );
    },
    async read(relative) {
      return readFile(path.join(project, relative), 'utf8');
    },
    async cli(args, options = {}) {
      const result = await command(process.execPath, [cliPath, ...args], {
        cwd: project,
        env,
        ...options,
      });
      outputs.push(result);
      return result;
    },
    async sql(sql, db = 'data.duckdb') {
      const result = await ctx.cli(['query', sql, '--db-path', path.join(project, db)]);
      return JSON.parse(result.stdout);
    },
    async cleanup() {
      await rm(project, { recursive: true, force: true });
    },
  };
  return ctx;
}
