import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse } from 'yaml';
import { DogsledConfigFragmentSchema } from '../../../src/runner/config/schema.js';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDestinationFor } from '../../../src/runtime/source-materializer/destination-resolver.js';
import {
  resolveLocalDestination,
  runLocalInit,
  shouldRunLocalInit,
} from '../../../src/commands/init-local.js';

let workDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dogsled-init-local-'));
  process.chdir(workDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('shouldRunLocalInit', () => {
  it('returns true for any of --local / --ducklake / --duckdb / --destination', () => {
    expect(shouldRunLocalInit({ local: true })).toBe(true);
    expect(shouldRunLocalInit({ ducklake: true })).toBe(true);
    expect(shouldRunLocalInit({ duckdb: true })).toBe(true);
    expect(shouldRunLocalInit({ destination: 'postgres' })).toBe(true);
  });

  it('returns false when no local flag is set', () => {
    expect(shouldRunLocalInit({})).toBe(false);
    expect(shouldRunLocalInit({ projectName: 'acme' })).toBe(false);
  });
});

describe('resolveLocalDestination', () => {
  it('defaults to ducklake', () => {
    expect(resolveLocalDestination({ local: true })).toBe('ducklake');
  });

  it('honors --duckdb', () => {
    expect(resolveLocalDestination({ duckdb: true })).toBe('duckdb');
  });

  it('honors --destination over default', () => {
    expect(resolveLocalDestination({ destination: 'postgres' })).toBe('postgres');
    expect(resolveLocalDestination({ destination: 'snowflake' })).toBe('snowflake');
    expect(resolveLocalDestination({ destination: 'bigquery' })).toBe('bigquery');
  });

  it('rejects unsupported destination kinds', () => {
    expect(() => resolveLocalDestination({ destination: 'mysql' })).toThrow(/Unsupported/);
  });
});

describe('runLocalInit project-name validation (security)', () => {
  it('rejects project names containing path separators', async () => {
    await expect(runLocalInit({ local: true, projectName: '../escape' }, {})).rejects.toThrow(
      /single non-hidden path segment/
    );
    await expect(runLocalInit({ local: true, projectName: 'foo/bar' }, {})).rejects.toThrow(
      /single non-hidden path segment/
    );
    await expect(runLocalInit({ local: true, projectName: 'a\\b' }, {})).rejects.toThrow(
      /single non-hidden path segment/
    );
  });

  it('rejects project names that look like flags or hidden paths', async () => {
    await expect(runLocalInit({ local: true, projectName: '.hidden' }, {})).rejects.toThrow(
      /single non-hidden path segment/
    );
    await expect(runLocalInit({ local: true, projectName: '-rf' }, {})).rejects.toThrow(
      /single non-hidden path segment/
    );
  });

  it('rejects empty project name', async () => {
    await expect(runLocalInit({ local: true, projectName: '' }, {})).rejects.toThrow(
      /single non-hidden path segment/
    );
  });

  it('rejects project names containing control characters with exitCode 2', async () => {
    // Newlines/tabs/CR can be invisibly pasted via shell history or completion and
    // would corrupt the YAML scalar even after quoting. Validation contract:
    // CommandError with exitCode 2.
    for (const projectName of ['demo\nx', 'demo\rx', 'demo\tx', 'demox']) {
      await expect(runLocalInit({ local: true, projectName }, {})).rejects.toMatchObject({
        name: 'CommandError',
        exitCode: 2,
        message: expect.stringContaining('single non-hidden path segment'),
      });
    }
  });

  it('rejects project names with leading/trailing whitespace', async () => {
    for (const projectName of [' demo', 'demo ', '  demo  ']) {
      await expect(runLocalInit({ local: true, projectName }, {})).rejects.toMatchObject({
        name: 'CommandError',
        exitCode: 2,
      });
    }
  });
});

describe('runLocalInit (DuckLake default)', () => {
  it('refuses initialization into an existing non-empty directory', async () => {
    const projectDir = path.join(workDir, 'demo-existing');
    await fs.mkdir(projectDir, { recursive: true });
    const keepPath = path.join(projectDir, 'keep.txt');
    await fs.writeFile(keepPath, 'untouched', 'utf-8');

    await expect(
      runLocalInit({ local: true, projectName: 'demo-existing' }, {})
    ).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
      message: expect.stringContaining('already exists and is not empty'),
    });

    // Existing file remains intact — the guard fires before any scaffolding write.
    expect(await fs.readFile(keepPath, 'utf-8')).toBe('untouched');
    // No scaffolding files were created either.
    await expect(fs.access(path.join(projectDir, 'dogsled.yml'))).rejects.toThrow();
  });

  it('refuses initialization when the project path is an existing file', async () => {
    const filePath = path.join(workDir, 'demo-isfile');
    await fs.writeFile(filePath, 'a', 'utf-8');
    await expect(
      runLocalInit({ local: true, projectName: 'demo-isfile' }, {})
    ).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
      message: expect.stringContaining('exists as a file, not a directory'),
    });
  });

  it('scaffolds a project with all expected files', async () => {
    await runLocalInit({ local: true, projectName: 'demo' }, {});
    const projectDir = path.join(workDir, 'demo');

    await expect(fs.access(path.join(projectDir, 'bobsled.yml'))).rejects.toThrow();
    await expect(fs.access(path.join(projectDir, 'dogsled.yml'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectDir, '.dogsled', 'config.yml'))
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, '.dogsled', 'lake'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(projectDir, 'integrations', '.gitkeep'))
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, 'sources', '.gitkeep'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, '.gitignore'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, 'README.md'))).resolves.toBeUndefined();

    const config = await fs.readFile(path.join(projectDir, '.dogsled', 'config.yml'), 'utf-8');
    expect(config).toContain('dest: ducklake');
    expect(config).toContain('catalogUrl: ducklake:.dogsled/lake/catalog.ducklake');
    expect(config).not.toContain('kind:');
  });

  it('scaffolds a DuckDB-classic project', async () => {
    await runLocalInit({ duckdb: true, projectName: 'demo-duckdb' }, {});
    const config = await fs.readFile(
      path.join(workDir, 'demo-duckdb', '.dogsled', 'config.yml'),
      'utf-8'
    );
    const readme = await fs.readFile(path.join(workDir, 'demo-duckdb', 'README.md'), 'utf-8');
    expect(config).toContain('dest: duckdb');
    expect(config).toContain('dbPath: .dogsled/dogsled.duckdb');
    expect(readme).toContain('dogsled load run --dest duckdb --db-path .dogsled/dogsled.duckdb');
    // No lake directory.
    await expect(
      fs.access(path.join(workDir, 'demo-duckdb', '.dogsled', 'lake'))
    ).rejects.toThrow();
  });

  it('scaffolds a Postgres project whose lazy sources stay in local DuckLake', async () => {
    await runLocalInit({ destination: 'postgres', projectName: 'demo-pg' }, {});
    const config = await fs.readFile(
      path.join(workDir, 'demo-pg', '.dogsled', 'config.yml'),
      'utf-8'
    );
    expect(config).toContain('dest: ducklake');
    expect(config).not.toContain('password');
  });

  it.each(['ducklake', 'duckdb', 'postgres', 'snowflake', 'bigquery'] as const)(
    'writes a %s .dogsled/config.yml that the lazy-source destination resolver accepts',
    async (destination) => {
      const projectName = `demo-resolve-${destination}`;
      await runLocalInit({ destination, projectName }, {});
      const projectRoot = path.join(workDir, projectName);
      const resolved = await resolveDestinationFor({
        entry: {
          kind: 'api_resource',
          fqRef: 'sources.issues',
          integration: 'github',
          resource: 'issues',
          connection: 'github',
          columns: [{ name: 'id', type: 'integer' }],
        },
        projectRoot,
      });
      const expectedKind = destination === 'postgres' ? 'ducklake' : destination;
      expect(resolved.kind).toBe(expectedKind);
      expect(resolved.schema).toBe('bronze');
      const config = await fs.readFile(path.join(projectRoot, '.dogsled', 'config.yml'), 'utf-8');
      expect(parse(config).default_destination).not.toHaveProperty('password');
    }
  );

  it.each(['duckdb', 'ducklake'] as const)(
    'resolves the relative %s paths in .dogsled/config.yml against the project root',
    async (destination) => {
      const projectName = `demo-paths-${destination}`;
      await runLocalInit({ destination, projectName }, {});
      const projectRoot = path.join(workDir, projectName);
      const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'dogsled-init-cwd-'));
      const previousCwd = process.cwd();
      process.chdir(elsewhere);
      try {
        const resolved = await resolveDestinationFor({
          entry: {
            kind: 'api_resource',
            fqRef: 'sources.issues',
            integration: 'github',
            resource: 'issues',
            connection: 'github',
            columns: [{ name: 'id', type: 'integer' }],
          },
          projectRoot,
        });
        const config = resolved.config as { dbPath?: string; catalogUrl?: string };
        if (destination === 'duckdb') {
          expect(config.dbPath).toBe(path.join(projectRoot, '.dogsled', 'dogsled.duckdb'));
        } else {
          expect(config.catalogUrl).toBe(
            `ducklake:${path.join(projectRoot, '.dogsled', 'lake', 'catalog.ducklake')}`
          );
        }
      } finally {
        process.chdir(previousCwd);
        await fs.rm(elsewhere, { recursive: true, force: true });
      }
    }
  );

  it.each(['ducklake', 'duckdb', 'postgres', 'snowflake', 'bigquery'] as const)(
    'git-ignores everything in .dogsled/ except config.yml for a %s project',
    async (destination) => {
      const projectName = `demo-ignore-${destination}`;
      await runLocalInit({ destination, projectName }, {});
      const gitignore = await fs.readFile(path.join(workDir, projectName, '.gitignore'), 'utf-8');
      expect(gitignore.split('\n')).toEqual(
        expect.arrayContaining(['.dogsled/*', '!.dogsled/config.yml'])
      );
      const inner = await fs.readFile(
        path.join(workDir, projectName, '.dogsled', '.gitignore'),
        'utf-8'
      );
      expect(inner.split('\n')).toEqual(['*', '!.gitignore', '!config.yml', '']);
      const readme = await fs.readFile(path.join(workDir, projectName, 'README.md'), 'utf-8');
      expect(readme).not.toContain('connection details in .dogsled/config.yml');
    }
  );

  it('starter dogsled.yml is valid with and without its commented example', async () => {
    await runLocalInit({ local: true, projectName: 'demo' }, {});
    const dogsledYaml = await fs.readFile(path.join(workDir, 'demo', 'dogsled.yml'), 'utf-8');
    expect(dogsledYaml).toContain('default_embedding_v1');
    expect(dogsledYaml).toContain('platform:');
    expect(DogsledConfigFragmentSchema.safeParse(parse(dogsledYaml)).success).toBe(true);
    const uncommented = dogsledYaml
      .split('\n')
      .map((line) => (/^# {0,4}(destinations|pipelines|  )/.test(line) ? line.slice(2) : line))
      .join('\n');
    expect(uncommented).toContain('pipelines:');
    const parsed = DogsledConfigFragmentSchema.safeParse(parse(uncommented));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('generated README points at current extractor and loader commands', async () => {
    await runLocalInit({ local: true, projectName: 'demo' }, {});
    const readme = await fs.readFile(path.join(workDir, 'demo', 'README.md'), 'utf-8');

    expect(readme).toContain('dogsled extract run --integration <name> <resource>');
    expect(readme).toContain(
      'dogsled load run --dest ducklake --ducklake-catalog-url ducklake:.dogsled/lake/catalog.ducklake'
    );
    expect(readme).not.toContain('dogsled load run --dest duckdb');
    expect(readme).not.toContain('dogsled extract --all');
    expect(readme).not.toContain('dogsled load --all');
  });
});
