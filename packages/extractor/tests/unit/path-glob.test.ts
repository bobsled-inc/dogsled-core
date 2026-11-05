import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalFileStorageClient } from '../../src/runtime/clients/local-file-client.js';
import { globToRegExp } from '../../src/runtime/clients/path-glob.js';

describe('resource path globs', () => {
  it('lets `**/` match zero or more folders for S3 and SFTP', () => {
    const matcher = globToRegExp('**/*.csv', 'S3');
    expect(['a.csv', 'x/a.csv', 'x/y/a.csv'].every((key) => matcher.test(key))).toBe(true);
    expect(matcher.test('a.json')).toBe(false);
    const nested = globToRegExp('exports/**/*.csv', 'S3');
    expect(nested.test('exports/a.csv')).toBe(true);
    expect(nested.test('exports/x/a.csv')).toBe(true);
    expect(nested.test('other/a.csv')).toBe(false);
  });

  it('lets `**/` match top-level files for local sources', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'glob-local-'));
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'a.csv'), 'id\n1\n');
    await writeFile(path.join(root, 'sub/b.csv'), 'id\n2\n');
    const client = new LocalFileStorageClient({ base_directory: root });
    const listed: string[] = [];
    for await (const file of client.list({ path: '**/*.csv' })) listed.push(file.path);
    expect(listed.sort()).toEqual(['a.csv', 'sub/b.csv']);
  });
});
