import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManifest, getManifestPath, writeManifest } from '../../../src/runner/manifest.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('manifest helpers', () => {
  it('creates pending destination entries with allowlisted fields only', () => {
    const manifest = createManifest(
      'github',
      '/tmp/dogsled-capture-123/output.jsonl',
      [
        { name: 'warehouse', type: 'local', format: 'csv', load_strategy: 'append' },
        {
          name: 'analytics',
          type: 'postgres',
          host: 'db.example.com',
          database: 'warehouse',
          username: 'loader',
          password: '$PG_PASSWORD',
        },
      ],
      { pipelineName: 'nightly' }
    );

    expect(manifest.integration).toBe('github');
    expect(manifest.pipeline_name).toBe('nightly');
    expect(manifest.capture_file).toBe('/tmp/dogsled-capture-123/output.jsonl');
    expect(manifest.commit_state).toEqual({ status: 'pending' });
    expect(manifest.destinations).toEqual([
      {
        name: 'warehouse',
        type: 'local',
        load_strategy: 'append',
        status: 'pending',
      },
      {
        name: 'analytics',
        type: 'postgres',
        status: 'pending',
      },
    ]);
    expect(JSON.stringify(manifest)).not.toContain('db.example.com');
    expect(JSON.stringify(manifest)).not.toContain('loader');
    expect(JSON.stringify(manifest)).not.toContain('PG_PASSWORD');
  });

  it('writes parseable json with restricted permissions', () => {
    const tempDir = makeTempDir('dogsled-manifest-test-');
    const manifestPath = getManifestPath(tempDir);
    const manifest = createManifest('stripe', path.join(tempDir, 'output.jsonl'), [
      { name: 'warehouse', type: 'local', format: 'csv' },
    ]);

    writeManifest(manifestPath, manifest);

    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const stat = fs.statSync(manifestPath);
    expect(parsed.integration).toBe('stripe');
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(tempDir)).toEqual(['manifest.json']);
  });

  it('warns instead of throwing when writes fail', () => {
    const warning = vi.fn();
    const manifest = createManifest('notion', '/tmp/dogsled-capture-123/output.jsonl', [
      { name: 'warehouse', type: 'local', format: 'jsonl' },
    ]);
    const tempDir = makeTempDir('dogsled-manifest-missing-parent-');
    const manifestPath = path.join(tempDir, 'missing', 'manifest.json');

    expect(() => writeManifest(manifestPath, manifest, warning)).not.toThrow();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('cleans up the temp file when the atomic replace fails', () => {
    const warning = vi.fn();
    const tempDir = makeTempDir('dogsled-manifest-rename-failure-');
    const manifestPath = getManifestPath(tempDir);
    const manifest = createManifest('github', path.join(tempDir, 'output.jsonl'), [
      { name: 'warehouse', type: 'local', format: 'jsonl' },
    ]);
    fs.mkdirSync(manifestPath);

    expect(() => writeManifest(manifestPath, manifest, warning)).not.toThrow();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('EISDIR'));
    expect(fs.readdirSync(tempDir)).toEqual(['manifest.json']);
  });
});
