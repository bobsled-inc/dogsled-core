import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveActionProjectRoot } from '../../src/lib/action-paths.js';

describe('resolveActionProjectRoot', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('uses the current directory instead of searching parent projects', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bobsled-action-paths-config-'));
    const nestedDir = join(tempDir, 'apps', 'operator');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'bobsled.yml'),
      [
        'version: 2',
        'dataProducts:',
        '  - account: demo',
        '    accountSlug: demo',
        '    dataProduct: demo',
        '    name: Demo',
        '    path: data/demo',
      ].join('\n'),
      'utf-8'
    );
    process.chdir(nestedDir);

    try {
      expect(resolveActionProjectRoot()).toBe(realpathSync(nestedDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses an explicit project root', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bobsled-action-paths-actions-'));
    const nestedDir = join(tempDir, 'apps', 'operator');
    mkdirSync(join(tempDir, 'actions'), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'actions', 'notify_complete.yml'),
      [
        'spec_version: "1"',
        'type: action',
        'transport: webhook',
        'name: notify_complete',
        'description: Send a webhook',
        'input: {}',
        'webhook:',
        '  url: https://hooks.example.com/notify',
      ].join('\n'),
      'utf-8'
    );
    process.chdir(nestedDir);

    try {
      expect(resolveActionProjectRoot(undefined, tempDir)).toBe(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps an explicit config file as the legacy root selector', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bobsled-action-paths-project-config-'));
    const nestedDir = join(tempDir, 'crm', 'hubspot');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(tempDir, 'bobsled.yml'), 'pipelines: {}\n', 'utf-8');
    process.chdir(nestedDir);

    try {
      expect(resolveActionProjectRoot(join(tempDir, 'bobsled.yml'))).toBe(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not mistake nested GitHub action folders for project-local action specs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bobsled-action-paths-github-actions-'));
    const nestedDir = join(tempDir, 'apps', 'operator');
    mkdirSync(join(tempDir, 'actions', 'track-action'), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(tempDir, 'actions', 'track-action', 'action.yml'),
      ['name: track-action', 'description: GitHub action'].join('\n'),
      'utf-8'
    );
    process.chdir(nestedDir);

    try {
      expect(resolveActionProjectRoot()).toBe(realpathSync(nestedDir));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
