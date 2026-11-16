import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dogsled-setup-render-'));
  tempDirs.push(dir);
  return dir;
}

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`mocked ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function loadInstallCoworkAssetsWithFsMock(
  mockFactory: (actual: typeof import('node:fs')) => Promise<Partial<typeof import('node:fs')>>
) {
  vi.resetModules();
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
      ...actual,
      ...(await mockFactory(actual)),
    };
  });

  const [renderModule, protocolModule] = await Promise.all([
    import('../../../src/setup/render.js'),
    import('@bobsled-inc/protocol'),
  ]);
  return {
    CommandError: protocolModule.CommandError,
    installCoworkAssets: renderModule.installCoworkAssets,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('installCoworkAssets', () => {
  it('maps permission-related install failures to a CommandError with guidance', async () => {
    let code: 'EACCES' | 'EPERM' | 'EROFS' = 'EACCES';
    const { installCoworkAssets, CommandError } = await loadInstallCoworkAssetsWithFsMock(
      async (_actual) => ({
        cpSync: vi.fn((...args: Parameters<typeof _actual.cpSync>) => {
          void args;
          throw makeErrnoError(code);
        }),
      })
    );

    for (const permissionCode of ['EACCES', 'EPERM', 'EROFS'] as const) {
      code = permissionCode;
      const dir = createTempDir();

      try {
        installCoworkAssets(dir);
        throw new Error('Expected installCoworkAssets to throw');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CommandError);
        expect(error).toMatchObject({ exitCode: 2 });
        expect((error as Error).message).toContain(`Permission denied writing to "${dir}".`);
        expect((error as Error).message).toContain(
          'dogsled setup install --dir /path/to/writable/directory'
        );
      }
    }
  }, 30_000);

  it('preserves an existing starter answers file when exclusive create reports EEXIST', async () => {
    const dir = createTempDir();
    const answersPath = path.join(dir, 'dogsled.setup.answers.yml');
    const existingContent = 'project:\n  repo_name: existing-pipeline\n';
    writeFileSync(answersPath, existingContent, 'utf-8');

    const { installCoworkAssets } = await loadInstallCoworkAssetsWithFsMock(async (actual) => ({
      writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => {
        const [filePath] = args;
        if (filePath === answersPath) {
          throw makeErrnoError('EEXIST');
        }
        return actual.writeFileSync(...args);
      }),
    }));

    const copied = installCoworkAssets(dir);

    expect(readFileSync(answersPath, 'utf-8')).toBe(existingContent);
    expect(copied).not.toContain('dogsled.setup.answers.yml');
  });
});
