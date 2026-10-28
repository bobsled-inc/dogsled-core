import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadTarget } from '../../../src/fs/load-target.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures', import.meta.url));

describe('loadTarget', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-target-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads raw_load.yml from the fixtures dir', async () => {
    const parsed = await loadTarget(FIXTURE_DIR, 'raw_load');
    expect(parsed.name).toBe('raw_load');
    expect(parsed.integration).toBe('snowflake_prod');
    expect(parsed.overrides?.role).toBe('LOADER_ROLE');
  });

  it('throws CommandError(2) on missing file', async () => {
    await expect(loadTarget(FIXTURE_DIR, 'missing_target')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('rejects path-traversal handles', async () => {
    await expect(loadTarget(FIXTURE_DIR, '../etc/passwd')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('rejects handles with path separators', async () => {
    await expect(loadTarget(FIXTURE_DIR, 'a/b')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('throws CommandError(2) on YAML parse failure', async () => {
    await fs.mkdir(path.join(tmpDir, 'targets'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'targets', 'bad.yml'),
      'spec_version: "1"\n  : : not: valid: yaml: :: :\n'
    );
    await expect(loadTarget(tmpDir, 'bad')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('throws CommandError(2) on schema validation failure', async () => {
    await fs.mkdir(path.join(tmpDir, 'targets'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'targets', 'broken.yml'),
      'spec_version: "1"\ntype: target\nname: broken\n# missing integration field\n'
    );
    await expect(loadTarget(tmpDir, 'broken')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('honors custom dirName', async () => {
    const customDir = path.join(tmpDir, 'custom_targets');
    await fs.mkdir(customDir, { recursive: true });
    await fs.copyFile(
      path.join(FIXTURE_DIR, 'targets', 'raw_load.yml'),
      path.join(customDir, 'raw_load.yml')
    );
    const parsed = await loadTarget(tmpDir, 'raw_load', { dirName: 'custom_targets' });
    expect(parsed.name).toBe('raw_load');
    expect(parsed.integration).toBe('snowflake_prod');
  });

  it('rejects dirName with path traversal', async () => {
    await expect(loadTarget(FIXTURE_DIR, 'raw_load', { dirName: '../etc' })).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('rejects target files reached through a symlink', async () => {
    await fs.mkdir(path.join(tmpDir, 'targets'), { recursive: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-target-outside-'));
    try {
      await fs.copyFile(
        path.join(FIXTURE_DIR, 'targets', 'raw_load.yml'),
        path.join(outside, 'raw_load.yml')
      );
      await fs.symlink(
        path.join(outside, 'raw_load.yml'),
        path.join(tmpDir, 'targets', 'raw_load.yml')
      );

      await expect(loadTarget(tmpDir, 'raw_load')).rejects.toThrow(/symlink target file/i);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects target YAML larger than 1 MiB', async () => {
    await fs.mkdir(path.join(tmpDir, 'targets'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'targets', 'huge.yml'), 'x'.repeat(1024 * 1024 + 1));

    await expect(loadTarget(tmpDir, 'huge')).rejects.toThrow(/exceeds the 1048576-byte limit/i);
  });
});
