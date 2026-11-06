import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDuckDbPath, realDuckDbPath } from '../../../src/agentic/duckdb-file.js';

describe('where a DuckDB path really leads', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  function root(): string {
    const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'duckdb-path-')));
    directories.push(directory);
    return directory;
  }

  it('follows a link to a file that exists', async () => {
    const base = root();
    fs.writeFileSync(join(base, 'real.duckdb'), '');
    fs.symlinkSync(join(base, 'real.duckdb'), join(base, 'link.duckdb'));
    await expect(realDuckDbPath(join(base, 'link.duckdb'))).resolves.toBe(
      join(base, 'real.duckdb')
    );
  });

  it('follows a chain of links to a file that does not exist yet', async () => {
    const base = root();
    fs.symlinkSync('second.duckdb', join(base, 'first.duckdb'));
    fs.symlinkSync('real.duckdb', join(base, 'second.duckdb'));
    await expect(realDuckDbPath(join(base, 'first.duckdb'))).resolves.toBe(
      join(base, 'real.duckdb')
    );
  });

  it('reads a relative link against its real directory', async () => {
    const base = root();
    fs.mkdirSync(join(base, 'real/deep'), { recursive: true });
    fs.symlinkSync(join(base, 'real/deep'), join(base, 'alias'));
    fs.symlinkSync('../out.duckdb', join(base, 'real/deep/state.duckdb'));
    await expect(realDuckDbPath(join(base, 'alias/state.duckdb'))).resolves.toBe(
      join(base, 'real/out.duckdb')
    );
  });

  it('follows a link inside the text of a link before its parent', async () => {
    const base = root();
    fs.mkdirSync(join(base, 'real/deep'), { recursive: true });
    fs.symlinkSync(join(base, 'real/deep'), join(base, 'alias'));
    fs.symlinkSync('alias/../out.duckdb', join(base, 'state.duckdb'));
    await expect(realDuckDbPath(join(base, 'state.duckdb'))).resolves.toBe(
      join(base, 'real/out.duckdb')
    );
  });

  it('follows absolute link text', async () => {
    const base = root();
    fs.symlinkSync(join(base, 'missing/out.duckdb'), join(base, 'state.duckdb'));
    await expect(realDuckDbPath(join(base, 'state.duckdb'))).resolves.toBe(
      join(base, 'missing/out.duckdb')
    );
  });

  it.each([
    ['two links that name each other', ['a.duckdb', 'b.duckdb'], ['b.duckdb', 'a.duckdb']],
    ['a link to itself', ['a.duckdb', 'a.duckdb']],
    ['a link back through a missing directory', ['missing/../a.duckdb', 'a.duckdb']],
    ['a link that doubles at every step', ['a.duckdb/../a.duckdb/../a.duckdb', 'a.duckdb']],
  ])('stops at %s', async (_, ...links) => {
    const base = root();
    for (const [text, name] of links as string[][]) {
      fs.symlinkSync(text!, join(base, name!));
    }
    await expect(realDuckDbPath(join(base, 'a.duckdb'))).resolves.toEqual(expect.any(String));
  });

  it('creates nothing, where a store opening the file creates the parent', async () => {
    const base = root();
    const file = join(base, 'missing/deeper/state.duckdb');
    await expect(realDuckDbPath(file)).resolves.toBe(file);
    expect(fs.existsSync(join(base, 'missing'))).toBe(false);
    await expect(canonicalDuckDbPath(file)).resolves.toBe(file);
    expect(fs.existsSync(join(base, 'missing/deeper'))).toBe(true);
  });
});
