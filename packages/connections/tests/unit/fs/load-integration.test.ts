import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadIntegration, loadIntegrationDirectory } from '../../../src/fs/load-integration.js';

// The fixtures directory shipped with the package.
const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures', import.meta.url));

describe('loadIntegration', () => {
  it('loads snowflake_prod.yml from the fixtures dir', async () => {
    const parsed = await loadIntegration(FIXTURE_DIR, 'snowflake_prod');
    expect(parsed.name).toBe('snowflake_prod');
    expect(parsed.source_type).toBe('snowflake');
  });

  it('loads bigquery_analytics.yml from the fixtures dir', async () => {
    const parsed = await loadIntegration(FIXTURE_DIR, 'bigquery_analytics');
    expect(parsed.source_type).toBe('bigquery');
  });

  it('throws CommandError(2) when the file does not exist', async () => {
    await expect(loadIntegration(FIXTURE_DIR, 'missing_handle')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('throws CommandError(2) on invalid YAML (schema failure)', async () => {
    await expect(loadIntegration(FIXTURE_DIR, 'invalid')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('rejects path-traversal handles before touching the filesystem', async () => {
    await expect(loadIntegration(FIXTURE_DIR, '../etc/passwd')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
    await expect(loadIntegration(FIXTURE_DIR, 'sub/dir')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
    await expect(loadIntegration(FIXTURE_DIR, 'Snowflake-Prod')).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('honors custom dirName', async () => {
    // Point at a non-existent directory → not-found error, but via the custom
    // name rather than the default `integrations/`.
    await expect(
      loadIntegration(FIXTURE_DIR, 'snowflake_prod', { dirName: 'nonexistent_dir' })
    ).rejects.toMatchObject({ name: 'CommandError', exitCode: 2 });
  });

  it('loads directory-style integrations from <handle>/integration.yml', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-dir-integration-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'integrations', 'snowflake_prod'), { recursive: true });
      await fs.copyFile(
        path.join(FIXTURE_DIR, 'integrations', 'snowflake_prod.yml'),
        path.join(tmpDir, 'integrations', 'snowflake_prod', 'integration.yml')
      );

      const parsed = await loadIntegration(tmpDir, 'snowflake_prod');
      expect(parsed.name).toBe('snowflake_prod');
      expect(parsed.source_type).toBe('snowflake');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects integration files reached through a symlink', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-symlink-integration-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-symlink-outside-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'integrations'), { recursive: true });
      await fs.copyFile(
        path.join(FIXTURE_DIR, 'integrations', 'snowflake_prod.yml'),
        path.join(outside, 'snowflake_prod.yml')
      );
      await fs.symlink(
        path.join(outside, 'snowflake_prod.yml'),
        path.join(tmpDir, 'integrations', 'snowflake_prod.yml')
      );

      await expect(loadIntegration(tmpDir, 'snowflake_prod')).rejects.toThrow(
        /symlink integration file/i
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('loadIntegrationDirectory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-test-'));
    await fs.mkdir(path.join(tmpDir, 'integrations'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty map when the directory does not exist', async () => {
    const emptyProject = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-empty-'));
    try {
      const map = await loadIntegrationDirectory(emptyProject);
      expect(map.size).toBe(0);
    } finally {
      await fs.rm(emptyProject, { recursive: true, force: true });
    }
  });

  it('loads every valid file in the directory, keyed by name', async () => {
    await fs.copyFile(
      path.join(FIXTURE_DIR, 'integrations', 'snowflake_prod.yml'),
      path.join(tmpDir, 'integrations', 'snowflake_prod.yml')
    );
    await fs.copyFile(
      path.join(FIXTURE_DIR, 'integrations', 'bigquery_analytics.yml'),
      path.join(tmpDir, 'integrations', 'bigquery_analytics.yml')
    );

    const map = await loadIntegrationDirectory(tmpDir);
    expect([...map.keys()].sort()).toEqual(['bigquery_analytics', 'snowflake_prod']);
    expect(map.get('snowflake_prod')?.source_type).toBe('snowflake');
    expect(map.get('bigquery_analytics')?.source_type).toBe('bigquery');
  });

  it('skips non-yaml files', async () => {
    await fs.copyFile(
      path.join(FIXTURE_DIR, 'integrations', 'snowflake_prod.yml'),
      path.join(tmpDir, 'integrations', 'snowflake_prod.yml')
    );
    await fs.copyFile(
      path.join(FIXTURE_DIR, 'integrations', 'not-yaml.txt'),
      path.join(tmpDir, 'integrations', 'not-yaml.txt')
    );

    const map = await loadIntegrationDirectory(tmpDir);
    expect(map.size).toBe(1);
    expect(map.has('snowflake_prod')).toBe(true);
  });

  it('loads directory-style integrations keyed by directory name', async () => {
    await fs.mkdir(path.join(tmpDir, 'integrations', 'snowflake_prod'), { recursive: true });
    await fs.copyFile(
      path.join(FIXTURE_DIR, 'integrations', 'snowflake_prod.yml'),
      path.join(tmpDir, 'integrations', 'snowflake_prod', 'integration.yml')
    );

    const map = await loadIntegrationDirectory(tmpDir);
    expect([...map.keys()]).toEqual(['snowflake_prod']);
    expect(map.get('snowflake_prod')?.source_type).toBe('snowflake');
  });

  it('throws CommandError(2) on duplicate integration names', async () => {
    const src = await fs.readFile(
      path.join(FIXTURE_DIR, 'integrations', 'snowflake_prod.yml'),
      'utf-8'
    );
    await fs.writeFile(path.join(tmpDir, 'integrations', 'first.yml'), src);
    await fs.writeFile(path.join(tmpDir, 'integrations', 'second.yml'), src);

    await expect(loadIntegrationDirectory(tmpDir)).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('propagates validation errors from individual files', async () => {
    await fs.copyFile(
      path.join(FIXTURE_DIR, 'integrations', 'invalid.yml'),
      path.join(tmpDir, 'integrations', 'invalid.yml')
    );
    await expect(loadIntegrationDirectory(tmpDir)).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 2,
    });
  });

  it('rejects symlink entries instead of following them', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-directory-outside-'));
    try {
      await fs.copyFile(
        path.join(FIXTURE_DIR, 'integrations', 'snowflake_prod.yml'),
        path.join(outside, 'snowflake_prod.yml')
      );
      await fs.symlink(
        path.join(outside, 'snowflake_prod.yml'),
        path.join(tmpDir, 'integrations', 'snowflake_prod.yml')
      );

      await expect(loadIntegrationDirectory(tmpDir)).rejects.toThrow(/symlink integration entry/i);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
