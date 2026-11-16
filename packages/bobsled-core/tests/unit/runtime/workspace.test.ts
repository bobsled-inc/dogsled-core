import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CommandError } from '@bobsled-inc/protocol';
import {
  findWorkspaceRoot,
  resolveCliInvocation,
  tryFindWorkspaceRoot,
} from '../../../src/runtime/workspace.js';

const tempDirs: string[] = [];
const require = createRequire(import.meta.url);
const tsxImportPath = require.resolve('tsx/esm');

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-workspace-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, contents = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace resolution', () => {
  it('finds the monorepo root when pnpm-workspace.yaml is present', () => {
    const root = makeTempDir();
    writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFile(path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js'));

    const metaUrl = pathToFileURL(
      path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js')
    ).href;

    expect(findWorkspaceRoot(metaUrl)).toBe(root);
    expect(tryFindWorkspaceRoot(metaUrl)).toBe(root);
  });

  it('returns null when no workspace root can be found', () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, 'app', 'dist', 'index.js'));

    const metaUrl = pathToFileURL(path.join(dir, 'app', 'dist', 'index.js')).href;

    expect(tryFindWorkspaceRoot(metaUrl)).toBeNull();
    expect(() => findWorkspaceRoot(metaUrl)).toThrowError(
      new CommandError('Unable to locate the workspace root for the unified dogsled CLI.')
    );
  });

  it('prefers workspace source files when running inside the repository', () => {
    const root = makeTempDir();
    writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFile(path.join(root, 'packages', 'extractor', 'src', 'index.ts'));
    writeFile(path.join(root, 'packages', 'extractor', 'dist', 'index.js'));
    writeFile(path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js'));

    const metaUrl = pathToFileURL(
      path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js')
    ).href;
    const invocation = resolveCliInvocation('extract', metaUrl, ['validate']);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      '--import',
      tsxImportPath,
      path.join(root, 'packages', 'extractor', 'src', 'index.ts'),
      'validate',
    ]);
  });

  it('uses the resolved tsx import path for source-mode workspace CLIs', () => {
    const root = makeTempDir();
    writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFile(path.join(root, 'packages', 'extractor', 'src', 'index.ts'));
    writeFile(path.join(root, 'packages', 'bobsled-core', 'src', 'index.ts'));

    const metaUrl = pathToFileURL(
      path.join(root, 'packages', 'bobsled-core', 'src', 'index.ts')
    ).href;
    const invocation = resolveCliInvocation('extract', metaUrl, ['validate']);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      '--import',
      tsxImportPath,
      path.join(root, 'packages', 'extractor', 'src', 'index.ts'),
      'validate',
    ]);
  });

  it('resolves the embedder CLI from workspace source files', () => {
    const root = makeTempDir();
    writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFile(path.join(root, 'packages', 'embedder', 'src', 'index.ts'));
    writeFile(path.join(root, 'packages', 'bobsled-core', 'src', 'index.ts'));

    const metaUrl = pathToFileURL(
      path.join(root, 'packages', 'bobsled-core', 'src', 'index.ts')
    ).href;
    const invocation = resolveCliInvocation('embed', metaUrl, ['run', '--config-json', '{}']);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      '--import',
      tsxImportPath,
      path.join(root, 'packages', 'embedder', 'src', 'index.ts'),
      'run',
      '--config-json',
      '{}',
    ]);
  });

  it('resolves the entity graph CLI from workspace source files', () => {
    const root = makeTempDir();
    writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFile(path.join(root, 'packages', 'entity-graph', 'src', 'index.ts'));
    writeFile(path.join(root, 'packages', 'bobsled-core', 'src', 'index.ts'));

    const metaUrl = pathToFileURL(
      path.join(root, 'packages', 'bobsled-core', 'src', 'index.ts')
    ).href;
    const invocation = resolveCliInvocation('entity-graph', metaUrl, ['resolve', 'validate']);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      '--import',
      tsxImportPath,
      path.join(root, 'packages', 'entity-graph', 'src', 'index.ts'),
      'resolve',
      'validate',
    ]);
  });

  it('falls back to the dist CLI when tsx resolution fails', () => {
    const root = makeTempDir();
    writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFile(path.join(root, 'packages', 'extractor', 'src', 'index.ts'));
    writeFile(path.join(root, 'packages', 'extractor', 'dist', 'index.js'));
    writeFile(path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js'));

    const metaUrl = pathToFileURL(
      path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js')
    ).href;
    const invocation = resolveCliInvocation('extract', metaUrl, ['validate'], () => {
      throw new CommandError('tsx unavailable');
    });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      path.join(root, 'packages', 'extractor', 'dist', 'index.js'),
      'validate',
    ]);
  });

  it('runs the installed entity graph CLI, not its library entry', () => {
    const root = makeTempDir();
    const metaFile = path.join(root, 'dogsled', 'dist', 'index.js');
    const packageDir = path.join(root, 'dogsled', 'node_modules', '@bobsled-inc', 'entity-graph');
    writeFile(metaFile);
    writeFile(path.join(packageDir, 'dist', 'index.js'), 'export {};\n');
    writeFile(path.join(packageDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n');

    const invocation = resolveCliInvocation('entity-graph', pathToFileURL(metaFile).href, [
      'status',
    ]);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      fs.realpathSync(path.join(packageDir, 'dist', 'cli.js')),
      'status',
    ]);
  });

  it('falls back to the built entity graph CLI in the workspace', () => {
    const root = makeTempDir();
    writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFile(path.join(root, 'packages', 'entity-graph', 'dist', 'index.js'));
    writeFile(path.join(root, 'packages', 'entity-graph', 'dist', 'cli.js'));
    writeFile(path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js'));

    const metaUrl = pathToFileURL(
      path.join(root, 'packages', 'bobsled-core', 'dist', 'index.js')
    ).href;
    const invocation = resolveCliInvocation('entity-graph', metaUrl, ['status']);

    expect(invocation.args).toEqual([
      path.join(root, 'packages', 'entity-graph', 'dist', 'cli.js'),
      'status',
    ]);
  });

  it('falls back to installed package dependencies outside the repository', () => {
    const root = makeTempDir();
    const metaFile = path.join(root, 'dogsled', 'dist', 'index.js');
    const extractorRuntime = path.join(
      root,
      'dogsled',
      'node_modules',
      '@bobsled-inc',
      'extractor',
      'dist',
      'runtime',
      'index.js'
    );
    const extractorCli = path.join(
      root,
      'dogsled',
      'node_modules',
      '@bobsled-inc',
      'extractor',
      'dist',
      'index.js'
    );

    writeFile(metaFile);
    writeFile(
      path.join(root, 'node_modules', '@bobsled-inc', 'extractor', 'package.json'),
      JSON.stringify(
        {
          name: '@bobsled-inc/extractor',
          type: 'module',
          exports: {
            '.': {
              import: './dist/runtime/index.js',
            },
          },
        },
        null,
        2
      )
    );
    writeFile(extractorRuntime, 'export {};\n');
    writeFile(extractorCli, '#!/usr/bin/env node\n');

    const metaUrl = pathToFileURL(metaFile).href;
    const invocation = resolveCliInvocation('extract', metaUrl, ['validate']);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([fs.realpathSync(extractorCli), 'validate']);
  });
});
